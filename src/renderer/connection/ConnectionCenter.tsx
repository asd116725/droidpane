import { useEffect, useRef, useState } from "react";
import { Alert, Button, Form, Input, InputNumber, Modal, Tabs } from "antd";
import { IconDeviceMobile, IconRefresh, IconWifi, IconX } from "@tabler/icons-react";
import type { AdbStudioApi, DeviceInfo } from "../../shared/types";
import type { WirelessEndpoint, WirelessState } from "../../shared/connection";

interface ConnectionCenterProps {
  api: AdbStudioApi;
  state: WirelessState;
  devices: DeviceInfo[];
  locked: boolean;
  onState(state: WirelessState): void;
  onConnected(serial: string, isCurrent: () => boolean): Promise<void>;
  onClose(): void;
}

/** 无线接入中心；配对端口和连接端口分开保存，取消后丢弃晚到结果。 */
export function ConnectionCenter({ api, state, devices, locked, onState, onConnected, onClose }: ConnectionCenterProps) {
  const [tab, setTab] = useState(state.profiles.length ? "recent" : "add");
  const [mode, setMode] = useState<"pair" | "connect">("pair");
  const [host, setHost] = useState("");
  const [pairPort, setPairPort] = useState<number | null>(null);
  const [connectPort, setConnectPort] = useState<number | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [rename, setRename] = useState<{ id: string; name: string }>();
  const generation = useRef(0);
  const pending = useRef(false);

  useEffect(() => () => {
    generation.current += 1;
    if (pending.current) void api.cancelWirelessOperation();
  }, [api]);

  const cancel = async () => {
    const current = ++generation.current;
    pending.current = false;
    setCode("");
    try {
      const cancellation = api.cancelWirelessOperation();
      if (starting) await api.stopMirroring();
      const result = await cancellation;
      if (current === generation.current) onState(result);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "取消连接失败");
    } finally {
      if (current === generation.current) { setBusy(false); setStarting(false); }
    }
  };

  /** 只有本次操作仍有效时才进入镜像，设备连接成功不会修改录制状态。 */
  const run = async (operation: () => Promise<WirelessState>) => {
    const current = ++generation.current;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await operation();
      if (current !== generation.current) return;
      onState(result);
      setCode("");
      if (result.status === "connected" && result.deviceSerial) {
        setStarting(true);
        await onConnected(result.deviceSerial, () => current === generation.current);
        if (current === generation.current) { pending.current = false; onClose(); }
      } else if (result.paired) {
        setMode("connect");
      }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "设备连接失败");
    } finally {
      if (current === generation.current) {
        pending.current = false;
        setBusy(false);
        setStarting(false);
      }
    }
  };

  const connect = (endpoint: WirelessEndpoint, profileId?: string) =>
    void run(() => api.connectWirelessDevice({ endpoint, profileId }));
  const discover = async () => {
    const current = generation.current;
    setError(undefined);
    try {
      const result = await api.discoverWirelessDevices();
      if (current === generation.current && !pending.current) onState(result);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "发现设备失败，请手动填写地址");
    }
  };
  const modifyProfile = async (operation: () => Promise<WirelessState>) => {
    try { onState(await operation()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "设备记录更新失败"); }
  };
  const availableDevices = devices.filter(device => device.status === "available");
  const port = mode === "pair" ? pairPort : connectPort;
  const canSubmit = host.trim().length > 0 && port !== null && port >= 1 && port <= 65535 &&
    (mode === "connect" || /^\d{6}$/.test(code));

  return <aside className="connection-center" aria-label="连接手机">
    <header className="connection-center__header">
      <div><IconWifi size={21} /><h2>连接手机</h2></div>
      <Button type="text" aria-label="关闭连接面板" icon={<IconX size={20} />}
        onClick={() => { void cancel().then(onClose); }} />
    </header>
    <div className="connection-center__body">
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: "recent", label: "最近设备" }, { key: "add", label: "添加设备" }
      ]} />
      {locked && <Alert type="info" showIcon title="请先停止录制，再连接其他设备" />}
      {(error || state.errorMessage) && <Alert type="error" showIcon title={error || state.errorMessage} />}
      {busy && <Alert type="info" showIcon title={starting ? "正在开启投屏" : state.message || "正在连接手机"}
        description={starting ? "收到有效画面后即可开始操作" : "请保持手机无线调试页面打开"} />}
      {!busy && state.paired && state.status !== "connected" && <Alert type="success" showIcon
        title="设备已配对" description="请填写无线调试主页的连接地址和端口，继续连接。" />}
      {tab === "recent" ? <div className="connection-center__devices">
        {state.profiles.map(profile => <article className="connection-device" key={profile.id}>
          <IconDeviceMobile size={23} />
          <div className="connection-device__content"><strong>{profile.name || profile.model}</strong>
            <span>{profile.endpoint.host}:{profile.endpoint.port} · 无线</span>
            <small>最近连接 {new Date(profile.lastConnectedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
            <div className="connection-device__actions">
              <Button size="small" type="link" disabled={busy} onClick={() => setRename({ id: profile.id, name: profile.name })}>重命名</Button>
              <Button size="small" type="link" disabled={busy} onClick={() => void modifyProfile(() => api.removeWirelessProfile(profile.id))}>移除记录</Button>
            </div>
          </div>
          <Button size="small" disabled={locked || busy} onClick={() => connect(profile.endpoint, profile.id)}>连接</Button>
        </article>)}
        {availableDevices.map(device => <article className="connection-device" key={device.serial}>
          <IconDeviceMobile size={23} /><div className="connection-device__content"><strong>{device.model}</strong>
            <span>{device.connectionType === "network" ? "无线" : device.connectionType === "emulator" ? "模拟器" : "USB"} · Android {device.androidVersion}</span>
          </div><div className="connection-device__buttons"><Button size="small" disabled={locked || busy} onClick={() => void run(async () => ({ ...state, status: "connected", deviceSerial: device.serial }))}>投屏</Button>
          {device.connectionType === "network" && <Button size="small" type="text" disabled={locked || busy} onClick={() => void modifyProfile(() => api.disconnectWirelessDevice(device.serial))}>断开</Button>}</div>
        </article>)}
        {!state.profiles.length && !availableDevices.length && <div className="connection-empty"><IconDeviceMobile size={38} stroke={1.4} />
          <strong>连接你的第一台手机</strong><p>添加无线设备，或连接已开启 USB 调试的手机。</p>
          <Button type="primary" onClick={() => setTab("add")}>添加设备</Button></div>}
        <p className="connection-center__hint">移除记录仅清理本机列表，不会撤销手机上的配对。</p>
      </div> : <>
        <div className="connection-guide"><span>ANDROID 11+</span>
          <h3>{mode === "pair" ? "打开无线调试，使用配对码连接" : "填写已配对手机的连接地址"}</h3>
          <p>手机与电脑连接同一 Wi-Fi。在手机「开发者选项 → 无线调试」中{mode === "pair" ? "打开「使用配对码配对设备」。" : "查看 IP 地址和端口。"}</p>
        </div>
        <Form layout="vertical" onFinish={() => {
          if (!canSubmit || locked || busy) return;
          if (mode === "pair") void run(() => api.pairWirelessDevice({ endpoint: { host: host.trim(), port: pairPort! }, code }));
          else connect({ host: host.trim(), port: connectPort! });
        }}>
          <Form.Item label="IP 地址或主机名" htmlFor="wireless-host"><Input id="wireless-host" value={host} disabled={locked || busy}
            placeholder="例如 192.168.1.24" autoComplete="off" onChange={event => setHost(event.target.value)} /></Form.Item>
          <Form.Item label={mode === "pair" ? "配对端口" : "连接端口"} htmlFor="wireless-port"
            extra={mode === "pair" ? "来自手机的配对码弹窗" : "来自无线调试主页，与配对端口不同"}>
            <InputNumber id="wireless-port" min={1} max={65535} precision={0} value={port} disabled={locked || busy}
              placeholder={mode === "pair" ? "配对弹窗中的端口" : "无线调试主页中的端口"}
              onChange={value => mode === "pair" ? setPairPort(value) : setConnectPort(value)} /></Form.Item>
          {mode === "pair" && <Form.Item label="6 位配对码" htmlFor="wireless-code"><Input id="wireless-code" value={code}
            disabled={locked || busy} inputMode="numeric" autoComplete="off" maxLength={6} placeholder="输入手机显示的配对码"
            onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></Form.Item>}
          <Button type="primary" htmlType="submit" block size="large" loading={busy} disabled={!canSubmit || locked || busy}>
            {mode === "pair" ? "配对并连接" : "连接并投屏"}</Button>
          {busy && <Button block className="connection-cancel" onClick={() => void cancel()}>取消连接</Button>}
        </Form>
        <Button type="link" block disabled={busy} onClick={() => { setMode(mode === "pair" ? "connect" : "pair"); setError(undefined); setCode(""); }}>
          {mode === "pair" ? "已配对？直接连接" : "尚未配对？使用配对码"}</Button>
        <div className="connection-discovery"><header><span>附近的无线设备</span>
          <Button type="text" size="small" icon={<IconRefresh size={16} />} disabled={busy} loading={state.status === "discovering"} onClick={() => void discover()}>发现设备</Button></header>
          {state.discoveries.map(candidate => <Button block className="connection-candidate" key={`${candidate.type}:${candidate.name}`}
            disabled={busy || locked} onClick={() => {
              setHost(candidate.endpoint.host);
              if (candidate.type === "pairing") { setMode("pair"); setPairPort(candidate.endpoint.port); }
              else { setMode("connect"); setConnectPort(candidate.endpoint.port); }
            }}><span>{candidate.name}</span><small>{candidate.type === "pairing" ? "可配对" : "可连接"} · {candidate.endpoint.port}</small></Button>)}
          {!state.discoveries.length && <p>未发现设备时，可直接手动填写上方地址。</p>}
        </div>
      </>}
      <footer className="connection-center__footer">连接其他设备会结束当前投屏。<br />Android 10 及以下可继续使用 USB 调试连接。</footer>
    </div>
    <Modal title="重命名设备" open={Boolean(rename)} onCancel={() => setRename(undefined)} okText="保存" cancelText="取消"
      okButtonProps={{ disabled: !rename?.name.trim() }} onOk={() => {
        if (rename) void modifyProfile(() => api.renameWirelessProfile(rename.id, rename.name.trim())).then(() => setRename(undefined));
      }}>
      <Input aria-label="设备昵称" maxLength={60} value={rename?.name || ""} onChange={event => setRename(current => current && { ...current, name: event.target.value })} />
    </Modal>
  </aside>;
}
