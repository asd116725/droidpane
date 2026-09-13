import {
  AdbClient,
  type ExecutableRunner
} from "../../src/main/adb/client";

describe("ADB 客户端", () => {
  it("用参数数组列出并补齐可用设备属性", async () => {
    /** 执行过的参数数组。 */
    const calls: string[][] = [];
    /** 可控命令执行器。 */
    const runner: ExecutableRunner = async (_file, arguments_) => {
      calls.push(arguments_);

      if (arguments_[0] === "devices") {
        return {
          stdout:
            "List of devices attached\nSERIAL device model:Pixel_8_Pro transport_id:1\nUNAUTH unauthorized transport_id:2\n",
          stderr: ""
        };
      }

      return {
        stdout: [
          "[ro.product.model]: [Pixel 8 Pro]",
          "[ro.build.version.release]: [14]",
          "[ro.build.version.sdk]: [34]"
        ].join("\n"),
        stderr: ""
      };
    };
    /** ADB 客户端。 */
    const client = new AdbClient("/runtime/adb", runner);

    await expect(client.listDevices()).resolves.toEqual([
      {
        serial: "SERIAL",
        model: "Pixel 8 Pro",
        androidVersion: "14",
        apiLevel: 34,
        connectionType: "usb",
        status: "available"
      },
      {
        serial: "UNAUTH",
        model: "未知设备",
        androidVersion: "",
        apiLevel: 0,
        connectionType: "usb",
        status: "unauthorized"
      }
    ]);
    expect(calls).toEqual([
      ["devices", "-l"],
      ["-s", "SERIAL", "shell", "getprop"]
    ]);
  });

  it("通过设备端 kill -2 停止指定服务 PID", async () => {
    /** 可控命令执行器。 */
    const runner = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
    /** ADB 客户端。 */
    const client = new AdbClient("/runtime/adb", runner);

    await client.interruptServer("SERIAL", 931);

    expect(runner).toHaveBeenCalledWith("/runtime/adb", [
      "-s",
      "SERIAL",
      "shell",
      "kill",
      "-2",
      "931"
    ]);
  });

  it("使用短超时按 SCID 精确查询服务 PID", async () => {
    /** 包含两个并行会话的进程列表。 */
    const runner = jest.fn().mockResolvedValue({
      stdout: [
        "PID ARGS",
        "920 app_process / com.genymobile.scrcpy.Server 4.1 scid=019fb6c8",
        "931 app_process / com.genymobile.scrcpy.Server 4.1 scid=019fb6c9"
      ].join("\n"),
      stderr: ""
    });
    /** ADB 客户端。 */
    const client = new AdbClient("/runtime/adb", runner);

    await expect(client.findServerPid("SERIAL", 0x19fb6c9)).resolves.toBe(
      931
    );
    expect(runner).toHaveBeenCalledWith(
      "/runtime/adb",
      ["-s", "SERIAL", "shell", "ps", "-A", "-o", "PID,ARGS"],
      1_000
    );
  });

  it("推送服务端并创建、移除动态 forward 隧道", async () => {
    /** 可控命令执行器。 */
    const runner = jest
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "38127\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    /** ADB 客户端。 */
    const client = new AdbClient("/runtime/adb", runner);

    await client.pushServer(
      "SERIAL",
      "/runtime/scrcpy-server",
      "/data/local/tmp/scrcpy-server.jar"
    );
    await expect(
      client.createForward("SERIAL", "scrcpy_019fb6c9")
    ).resolves.toBe(38127);
    await client.removeForward("SERIAL", 38127);

    expect(runner.mock.calls).toEqual([
      [
        "/runtime/adb",
        [
          "-s",
          "SERIAL",
          "push",
          "/runtime/scrcpy-server",
          "/data/local/tmp/scrcpy-server.jar"
        ]
      ],
      [
        "/runtime/adb",
        [
          "-s",
          "SERIAL",
          "forward",
          "tcp:0",
          "localabstract:scrcpy_019fb6c9"
        ]
      ],
      [
        "/runtime/adb",
        ["-s", "SERIAL", "forward", "--remove", "tcp:38127"]
      ]
    ]);
  });
});
