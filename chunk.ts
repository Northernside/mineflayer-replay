// buffer -> b64 -> msgpack encoding
function serializeData(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (Buffer.isBuffer(obj)) {
        return {
            __type: "Buffer",
            __data: obj.toString("base64")
        };
    }

    if (Array.isArray(obj)) {
        return obj.map(serializeData);
    }

    if (typeof obj === "object") {
        const result: any = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                result[key] = serializeData(obj[key]);
            }
        }

        return result;
    }

    return obj;
}

// msgpack decoding -> b64 -> buffer
function deserializeData(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    // restore marked buffers
    if (typeof obj === "object" && obj.__type === "Buffer" && typeof obj.__data === "string") {
        return Buffer.from(obj.__data, "base64");
    }

    if (Array.isArray(obj)) {
        return obj.map(deserializeData);
    }

    if (typeof obj === "object") {
        const result: any = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                result[key] = deserializeData(obj[key]);
            }
        }

        return result;
    }

    return obj;
}

export { serializeData, deserializeData };