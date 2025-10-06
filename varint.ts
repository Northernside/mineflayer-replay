function encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    while (value >= 0x80) {
        bytes.push((value & 0x7F) | 0x80); // continuation bit
        value >>>= 7;
    }

    bytes.push(value & 0x7F);
    return Buffer.from(bytes);
}

function decodeVarint(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;

    while (true) {
        if (offset + bytesRead >= buffer.length) {
            throw new Error("Unexpected end of buffer while decoding varint");
        }

        const byte = buffer[offset + bytesRead]!;
        value |= (byte & 0x7F) << shift;
        bytesRead++;

        if ((byte & 0x80) === 0) break;
        shift += 7;
    }

    return { value, bytesRead };
}

export { encodeVarint, decodeVarint };