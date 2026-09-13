import { resolveMainWindowBounds } from "../../src/main/window-bounds";

describe("主窗口尺寸", () => {
  it.each([
    {
      name: "常规工作区保留设计尺寸",
      workArea: { width: 1_920, height: 1_080 },
      expected: {
        width: 1_440,
        height: 1_024,
        minWidth: 900,
        minHeight: 640
      }
    },
    {
      name: "小屏工作区收敛初始尺寸",
      workArea: { width: 1_140, height: 812 },
      expected: {
        width: 1_140,
        height: 812,
        minWidth: 900,
        minHeight: 640
      }
    },
    {
      name: "工作区小于最小尺寸时同步收敛限制",
      workArea: { width: 800, height: 560 },
      expected: {
        width: 800,
        height: 560,
        minWidth: 800,
        minHeight: 560
      }
    }
  ])("$name", ({ workArea, expected }) => {
    expect(resolveMainWindowBounds(workArea)).toEqual(expected);
  });
});
