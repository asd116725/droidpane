import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionCenter } from "../../src/renderer/connection/ConnectionCenter";
import { createDemoApi } from "../../src/renderer/demo-api";
import type { AdbStudioApi } from "../../src/shared/types";
import type { WirelessState } from "../../src/shared/connection";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: jest.fn(query => ({
    matches: false, media: query, onchange: null,
    addListener: jest.fn(), removeListener: jest.fn(),
    addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn()
  })) });
});

const initialState: WirelessState = { status: "idle", discoveries: [], profiles: [], paired: false, operationId: 0 };

/** 模拟宿主接收状态，验证用户实际提交和取消流程。 */
function Harness({ api, connected, locked = false }: { api: AdbStudioApi; connected: jest.Mock; locked?: boolean }) {
  const [state, setState] = useState(initialState);
  return <ConnectionCenter api={api} state={state} devices={[]} locked={locked} onState={setState} onConnected={connected} onClose={jest.fn()} />;
}

describe("无线连接中心", () => {
  it("配对后保留地址但不复用配对端口，连接可用后才开启镜像", async () => {
    const api = createDemoApi();
    const pair = jest.spyOn(api, "pairWirelessDevice");
    const connect = jest.spyOn(api, "connectWirelessDevice");
    const connected = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Harness api={api} connected={connected} />);
    await user.type(screen.getByLabelText("IP 地址或主机名"), "192.168.1.24");
    await user.type(screen.getByLabelText("配对端口"), "37123");
    await user.type(screen.getByLabelText("6 位配对码"), "482916");
    await user.click(screen.getByRole("button", { name: "配对并连接" }));
    expect(pair).toHaveBeenCalledWith({ endpoint: { host: "192.168.1.24", port: 37123 }, code: "482916" });
    expect(await screen.findByText("设备已配对")).toBeInTheDocument();
    expect(screen.getByLabelText("连接端口")).toHaveValue("");
    expect(connected).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("连接端口"), "42871");
    await user.click(screen.getByRole("button", { name: "连接并投屏" }));
    await waitFor(() => expect(connected).toHaveBeenCalledWith("192.168.1.24:42871", expect.any(Function)));
    expect(connect).toHaveBeenCalledWith({ endpoint: { host: "192.168.1.24", port: 42871 }, profileId: undefined });
  });

  it("取消后忽略晚到连接结果，不启动旧设备", async () => {
    const api = createDemoApi();
    let resolve!: (state: WirelessState) => void;
    jest.spyOn(api, "connectWirelessDevice").mockReturnValue(new Promise(done => { resolve = done; }));
    const canceled = jest.spyOn(api, "cancelWirelessOperation");
    const connected = jest.fn();
    const user = userEvent.setup();
    render(<Harness api={api} connected={connected} />);
    await user.click(screen.getByRole("button", { name: "已配对？直接连接" }));
    await user.type(screen.getByLabelText("IP 地址或主机名"), "192.168.1.24");
    await user.type(screen.getByLabelText("连接端口"), "42871");
    await user.click(screen.getByRole("button", { name: "连接并投屏" }));
    await user.click(screen.getByRole("button", { name: "取消连接" }));
    await act(async () => resolve({ ...initialState, status: "connected", deviceSerial: "late-device" }));
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(connected).not.toHaveBeenCalled();
  });

  it("录制期间禁止配对和连接其他设备", () => {
    render(<Harness api={createDemoApi()} connected={jest.fn()} locked />);
    expect(screen.getByText("请先停止录制，再连接其他设备")).toBeInTheDocument();
    expect(screen.getByLabelText("IP 地址或主机名")).toBeDisabled();
    expect(screen.getByRole("button", { name: "配对并连接" })).toBeDisabled();
  });
});
