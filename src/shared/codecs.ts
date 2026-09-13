/** AAC 常用采样率索引表。 */
const aacSampleRates = [
  96_000,
  88_200,
  64_000,
  48_000,
  44_100,
  32_000,
  24_000,
  22_050,
  16_000,
  12_000,
  11_025,
  8_000,
  7_350
] as const;

/** AAC 解码所需的固定配置。 */
export interface AacConfig {
  /** WebCodecs 使用的 Codec String。 */
  codec: string;
  /** 采样率。 */
  sampleRate: number;
  /** 声道数量。 */
  numberOfChannels: number;
}

/** 解析 AAC AudioSpecificConfig。 */
export function parseAacConfig(data: Uint8Array): AacConfig {
  if (data.length < 2) {
    throw new Error("AAC 配置数据不完整");
  }

  /** MPEG-4 Audio Object Type。 */
  const objectType = data[0] >> 3;
  /** 采样率索引。 */
  const sampleRateIndex = ((data[0] & 0x07) << 1) | (data[1] >> 7);
  /** 声道配置。 */
  const numberOfChannels = (data[1] >> 3) & 0x0f;
  /** 对应采样率。 */
  const sampleRate = aacSampleRates[sampleRateIndex];

  if (!sampleRate || !numberOfChannels) {
    throw new Error("AAC 配置包含不支持的采样率或声道");
  }

  return {
    codec: `mp4a.40.${objectType}`,
    sampleRate,
    numberOfChannels
  };
}
