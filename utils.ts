function mapToObject(value: any): any {
    // values & null/undefined
    if (!value || typeof value !== "object") {
        return value;
    }

    // preserve buffers
    if (Buffer.isBuffer(value)) {
        return value;
    }

    // map to object
    if (value instanceof Map) {
        const obj: any = {};
        for (const [key, val] of value.entries()) {
            obj[key] = mapToObject(val);
        }

        return obj;
    }

    // recursively map arrays
    if (Array.isArray(value)) {
        return value.map(mapToObject);
    }

    // typed arrays to buffers
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }

    // plain object
    const obj: any = {};
    for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            obj[key] = mapToObject(value[key]);
        }
    }

    return obj;
}

export { mapToObject };