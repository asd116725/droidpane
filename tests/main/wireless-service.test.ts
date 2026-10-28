/** @jest-environment node */
import type { WirelessDeviceProfile, WirelessDiscovery } from "../../src/shared/connection";
import type { DeviceInfo } from "../../src/shared/types";
import { WirelessService } from "../../src/main/adb/wireless-service";

const endpoint = { host: "192.168.1.20", port: 39000 };
const pairing = { endpoint: { host: endpoint.host, port: 41000 }, code: "123456" };
const device: DeviceInfo = {
  serial: "192.168.1.20:39000",
  model: "Pixel 8",
  androidVersion: "14",
  apiLevel: 34,
  connectionType: "network",
  status: "available"
};
const discovery: WirelessDiscovery = { name: "adb-REAL-random", type: "connection", endpoint };
const profile: WirelessDeviceProfile = {
  id: "phone", name: "我的手机", model: device.model, identity: "serial:REAL",
  lastSerial: device.serial, endpoint, lastConnectedAt: 1
};

/** 可控完成时机，用于验证取消与持久化竞态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function createService(initialProfiles: WirelessDeviceProfile[] = []) {
  let profiles = initialProfiles;
  const adb = {
    listMdnsServices: jest.fn().mockResolvedValue([discovery]),
    pair: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    readIdentity: jest.fn().mockResolvedValue("serial:REAL")
  };
  const refreshDevices = jest.fn().mockResolvedValue([device]);
  const saveProfiles = jest.fn(async (value: WirelessDeviceProfile[]) => { profiles = value; });
  const service = new WirelessService({ adb, refreshDevices, saveProfiles, getProfiles: () => profiles });
  return { service, adb, refreshDevices, saveProfiles };
}

describe("无线连接服务", () => {
  it("配对后连接同一地址唯一的连接端口，保存已核验身份", async () => {
    const { service, adb } = createService();
    const state = await service.pair(pairing);
    expect(adb.pair).toHaveBeenCalledWith(pairing.endpoint, pairing.code, expect.any(AbortSignal));
    expect(adb.connect).toHaveBeenCalledWith(endpoint, expect.any(AbortSignal));
    expect(state).toMatchObject({ status: "connected", paired: true, deviceSerial: device.serial });
    expect(state.profiles[0]).toMatchObject({ identity: "serial:REAL", endpoint, lastSerial: device.serial });
    expect(service.profileForDevice(device.serial)?.identity).toBe("serial:REAL");
  });

  it("同 host 多个连接候选时等待手动选择，不把配对端口用于连接", async () => {
    const { service, adb } = createService();
    adb.listMdnsServices.mockResolvedValue([
      discovery,
      { ...discovery, name: "another", endpoint: { ...endpoint, port: 39001 } },
      { ...discovery, type: "pairing", endpoint: pairing.endpoint }
    ]);
    const state = await service.pair(pairing);
    expect(state.status).toBe("paired");
    expect(state.message).toContain("多个连接地址");
    expect(adb.connect).not.toHaveBeenCalled();
  });

  it("mDNS 不可用时保留已配对状态与手动连接入口", async () => {
    const { service, adb } = createService();
    adb.listMdnsServices.mockRejectedValue(new Error("mDNS unavailable"));
    const state = await service.pair(pairing);
    expect(state).toMatchObject({ status: "paired", paired: true });
    expect(state.message).toContain("连接地址");
    expect(adb.connect).not.toHaveBeenCalled();
  });

  it("取消后晚到的配对成功不继续连接或保存档案", async () => {
    const { service, adb, saveProfiles } = createService();
    const result = deferred<void>();
    adb.pair.mockReturnValue(result.promise);
    const task = service.pair(pairing);
    service.cancel();
    result.resolve(undefined);
    await task;
    expect(service.getState().status).toBe("idle");
    expect(adb.connect).not.toHaveBeenCalled();
    expect(saveProfiles).not.toHaveBeenCalled();
  });

  it("新操作成功后，旧操作迟到失败不能覆盖成功状态或泄漏配对码", async () => {
    const { service, adb } = createService();
    const old = deferred<void>();
    adb.pair.mockReturnValue(old.promise);
    const first = service.pair(pairing);
    await service.connect({ endpoint });
    old.resolve(undefined);
    await first;
    expect(service.getState()).toMatchObject({ status: "connected", operationId: 2 });
    expect(adb.connect).toHaveBeenCalledTimes(1);
    adb.pair.mockRejectedValue(new Error(`failed ${pairing.code}`));
    expect((await service.pair(pairing)).errorMessage).not.toContain(pairing.code);
  });

  it("根据 mDNS 名称识别 TLS 传输，并保留用户自定义名称", async () => {
    const { service, refreshDevices } = createService([profile]);
    refreshDevices.mockResolvedValue([{ ...device, serial: "adb-REAL-random._adb-tls-connect._tcp" }]);
    const state = await service.connect({ endpoint, profileId: profile.id });
    expect(state.status).toBe("connected");
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]).toMatchObject({ id: profile.id, name: "我的手机" });
  });

  it("历史地址指向其他设备时不发布连接成功或改写档案", async () => {
    const { service, adb, saveProfiles } = createService([profile]);
    adb.readIdentity.mockResolvedValue("serial:OTHER");
    const state = await service.connect({ endpoint, profileId: profile.id });
    expect(state.status).toBe("error");
    expect(state.errorMessage).toContain("不一致");
    expect(saveProfiles).not.toHaveBeenCalled();
  });

  it("没有身份的设备可显式连接，但禁止按旧地址自动恢复", async () => {
    const { service, adb, refreshDevices } = createService();
    adb.readIdentity.mockResolvedValue(undefined);
    const state = await service.connect({ endpoint });
    expect(state.status).toBe("connected");
    expect(state.message).toContain("手动连接");
    adb.connect.mockClear();
    refreshDevices.mockClear();
    await expect(service.reconnect(state.profiles[0], new AbortController().signal)).resolves.toBeUndefined();
    expect(adb.connect).not.toHaveBeenCalled();
    expect(refreshDevices).not.toHaveBeenCalled();
  });

  it("恢复使用新发现的地址，重新核实身份并更新当前传输", async () => {
    const { service, adb, refreshDevices } = createService([profile]);
    const movedEndpoint = { host: "192.168.1.30", port: 39500 };
    const movedDevice = { ...device, serial: "192.168.1.30:39500" };
    refreshDevices.mockResolvedValueOnce([]).mockResolvedValue([movedDevice]);
    adb.listMdnsServices.mockResolvedValue([{ ...discovery, endpoint: movedEndpoint }]);
    await expect(service.reconnect(profile, new AbortController().signal)).resolves.toEqual(movedDevice);
    expect(adb.connect).toHaveBeenCalledWith(movedEndpoint, expect.any(AbortSignal));
    expect(service.profileForDevice(movedDevice.serial)?.endpoint).toEqual(movedEndpoint);
  });

  it("恢复时相同地址身份变化不会返回错误设备", async () => {
    const { service, adb, saveProfiles } = createService([profile]);
    adb.readIdentity.mockResolvedValue("serial:OTHER");
    await expect(service.reconnect(profile, new AbortController().signal)).resolves.toBeUndefined();
    expect(saveProfiles).not.toHaveBeenCalled();
  });

  it("保存、改名和删除依次读取最新档案，不覆盖并发修改", async () => {
    const { service, saveProfiles } = createService([profile]);
    const firstSave = deferred<void>();
    const saveImplementation = saveProfiles.getMockImplementation()!;
    saveProfiles.mockImplementationOnce(async (profiles) => {
      await firstSave.promise;
      await saveImplementation(profiles);
    });
    const rename = service.renameProfile(profile.id, "新名称");
    const remove = service.removeProfile(profile.id);
    await Promise.resolve();
    expect(saveProfiles).toHaveBeenCalledTimes(1);
    firstSave.resolve(undefined);
    await Promise.all([rename, remove]);
    expect(service.getState().profiles).toEqual([]);
    expect(saveProfiles).toHaveBeenCalledTimes(2);
  });

  it("只断开目标无线设备，移除最近记录不会撤销系统配对", async () => {
    const { service, adb } = createService([profile]);
    await service.disconnect(device.serial);
    expect(adb.disconnect).toHaveBeenCalledWith(device.serial, expect.any(AbortSignal));
    await service.removeProfile(profile.id);
    expect(adb.disconnect).toHaveBeenCalledTimes(1);
  });
});
