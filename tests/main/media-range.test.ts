import { parseByteRange } from "../../src/main/media/range";

describe("媒体 Range 请求", () => {
  it("解析显式结束位置与开放结束位置", () => {
    expect(parseByteRange("bytes=100-199", 1_000)).toEqual({
      start: 100,
      end: 199
    });
    expect(parseByteRange("bytes=900-", 1_000)).toEqual({
      start: 900,
      end: 999
    });
  });

  it("拒绝越界、多段与非字节范围", () => {
    expect(parseByteRange("bytes=1000-", 1_000)).toBeNull();
    expect(parseByteRange("bytes=0-1,4-5", 1_000)).toBeNull();
    expect(parseByteRange("items=0-1", 1_000)).toBeNull();
  });
});
