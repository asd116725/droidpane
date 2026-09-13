import {
  findScrcpyServerPid,
  parseScrcpyServerPids
} from "../../src/main/recording/process";

describe("scrcpy 服务端进程识别", () => {
  it("只解析 scrcpy Server 行中的 PID", () => {
    /** Android ps 输出。 */
    const output = [
      "PID ARGS",
      "710 adbd --root_seclabel=u:r:su:s0",
      "919 sh -c CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 4.1",
      "920 app_process / com.genymobile.scrcpy.Server 4.1 scid=1a2b3c4d",
      "931 /system/bin/app_process64 / com.genymobile.scrcpy.Server 4.1 scid=ffeeddcc"
    ].join("\n");

    expect(parseScrcpyServerPids(output)).toEqual([920, 931]);
  });

  it("按 SCID 精确找出本次服务端 PID", () => {
    /** 同时运行的两个 scrcpy 会话。 */
    const output = [
      "PID ARGS",
      "920 app_process / com.genymobile.scrcpy.Server 4.1 scid=1a2b3c4d",
      "931 /system/bin/app_process64 / com.genymobile.scrcpy.Server 4.1 scid=ffeeddcc"
    ].join("\n");

    expect(findScrcpyServerPid(output, "ffeeddcc")).toBe(931);
    expect(findScrcpyServerPid(output, "00000000")).toBeUndefined();
  });
});
