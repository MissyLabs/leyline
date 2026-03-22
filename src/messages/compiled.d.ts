import * as $protobuf from "protobufjs";
import Long = require("long");
/** Namespace magic. */
export namespace magic {

    /** Properties of a MagicMessage. */
    interface IMagicMessage {

        /** MagicMessage id */
        id?: (Uint8Array|null);

        /** MagicMessage senderPubkey */
        senderPubkey?: (Uint8Array|null);

        /** MagicMessage signature */
        signature?: (Uint8Array|null);

        /** MagicMessage tags */
        tags?: (string[]|null);

        /** MagicMessage payload */
        payload?: (Uint8Array|null);

        /** MagicMessage timestamp */
        timestamp?: (number|Long|null);

        /** MagicMessage nonce */
        nonce?: (Uint8Array|null);

        /** MagicMessage type */
        type?: (magic.MessageType|null);

        /** MagicMessage ttl */
        ttl?: (number|null);
    }

    /** Represents a MagicMessage. */
    class MagicMessage implements IMagicMessage {

        /**
         * Constructs a new MagicMessage.
         * @param [properties] Properties to set
         */
        constructor(properties?: magic.IMagicMessage);

        /** MagicMessage id. */
        public id: Uint8Array;

        /** MagicMessage senderPubkey. */
        public senderPubkey: Uint8Array;

        /** MagicMessage signature. */
        public signature: Uint8Array;

        /** MagicMessage tags. */
        public tags: string[];

        /** MagicMessage payload. */
        public payload: Uint8Array;

        /** MagicMessage timestamp. */
        public timestamp: (number|Long);

        /** MagicMessage nonce. */
        public nonce: Uint8Array;

        /** MagicMessage type. */
        public type: magic.MessageType;

        /** MagicMessage ttl. */
        public ttl: number;

        /**
         * Creates a new MagicMessage instance using the specified properties.
         * @param [properties] Properties to set
         * @returns MagicMessage instance
         */
        public static create(properties?: magic.IMagicMessage): magic.MagicMessage;

        /**
         * Encodes the specified MagicMessage message. Does not implicitly {@link magic.MagicMessage.verify|verify} messages.
         * @param message MagicMessage message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: magic.IMagicMessage, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified MagicMessage message, length delimited. Does not implicitly {@link magic.MagicMessage.verify|verify} messages.
         * @param message MagicMessage message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: magic.IMagicMessage, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a MagicMessage message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns MagicMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): magic.MagicMessage;

        /**
         * Decodes a MagicMessage message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns MagicMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): magic.MagicMessage;

        /**
         * Verifies a MagicMessage message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a MagicMessage message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns MagicMessage
         */
        public static fromObject(object: { [k: string]: any }): magic.MagicMessage;

        /**
         * Creates a plain object from a MagicMessage message. Also converts values to other types if specified.
         * @param message MagicMessage
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: magic.MagicMessage, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this MagicMessage to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for MagicMessage
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** MessageType enum. */
    enum MessageType {
        MESSAGE_TYPE_UNSPECIFIED = 0,
        MESSAGE_TYPE_BROADCAST = 1,
        MESSAGE_TYPE_DIRECT = 2,
        MESSAGE_TYPE_ADVERTISE = 3,
        MESSAGE_TYPE_DISCOVER = 4,
        MESSAGE_TYPE_DISCOVER_RESPONSE = 5
    }

    /** Properties of a LedgerEntry. */
    interface ILedgerEntry {

        /** LedgerEntry index */
        index?: (number|Long|null);

        /** LedgerEntry prevHash */
        prevHash?: (Uint8Array|null);

        /** LedgerEntry hash */
        hash?: (Uint8Array|null);

        /** LedgerEntry message */
        message?: (magic.IMagicMessage|null);

        /** LedgerEntry recordedAt */
        recordedAt?: (number|Long|null);

        /** LedgerEntry action */
        action?: (magic.LedgerAction|null);
    }

    /** Represents a LedgerEntry. */
    class LedgerEntry implements ILedgerEntry {

        /**
         * Constructs a new LedgerEntry.
         * @param [properties] Properties to set
         */
        constructor(properties?: magic.ILedgerEntry);

        /** LedgerEntry index. */
        public index: (number|Long);

        /** LedgerEntry prevHash. */
        public prevHash: Uint8Array;

        /** LedgerEntry hash. */
        public hash: Uint8Array;

        /** LedgerEntry message. */
        public message?: (magic.IMagicMessage|null);

        /** LedgerEntry recordedAt. */
        public recordedAt: (number|Long);

        /** LedgerEntry action. */
        public action: magic.LedgerAction;

        /**
         * Creates a new LedgerEntry instance using the specified properties.
         * @param [properties] Properties to set
         * @returns LedgerEntry instance
         */
        public static create(properties?: magic.ILedgerEntry): magic.LedgerEntry;

        /**
         * Encodes the specified LedgerEntry message. Does not implicitly {@link magic.LedgerEntry.verify|verify} messages.
         * @param message LedgerEntry message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: magic.ILedgerEntry, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified LedgerEntry message, length delimited. Does not implicitly {@link magic.LedgerEntry.verify|verify} messages.
         * @param message LedgerEntry message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: magic.ILedgerEntry, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a LedgerEntry message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns LedgerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): magic.LedgerEntry;

        /**
         * Decodes a LedgerEntry message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns LedgerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): magic.LedgerEntry;

        /**
         * Verifies a LedgerEntry message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a LedgerEntry message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns LedgerEntry
         */
        public static fromObject(object: { [k: string]: any }): magic.LedgerEntry;

        /**
         * Creates a plain object from a LedgerEntry message. Also converts values to other types if specified.
         * @param message LedgerEntry
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: magic.LedgerEntry, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this LedgerEntry to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for LedgerEntry
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** LedgerAction enum. */
    enum LedgerAction {
        LEDGER_ACTION_UNSPECIFIED = 0,
        LEDGER_ACTION_SENT = 1,
        LEDGER_ACTION_RECEIVED = 2,
        LEDGER_ACTION_BLOCKED = 3,
        LEDGER_ACTION_RELAYED = 4
    }

    /** Properties of a SharedLedgerEntry. */
    interface ISharedLedgerEntry {

        /** SharedLedgerEntry index */
        index?: (number|Long|null);

        /** SharedLedgerEntry prevHash */
        prevHash?: (Uint8Array|null);

        /** SharedLedgerEntry hash */
        hash?: (Uint8Array|null);

        /** SharedLedgerEntry data */
        data?: (Uint8Array|null);

        /** SharedLedgerEntry submitterPubkey */
        submitterPubkey?: (Uint8Array|null);

        /** SharedLedgerEntry signature */
        signature?: (Uint8Array|null);

        /** SharedLedgerEntry timestamp */
        timestamp?: (number|Long|null);

        /** SharedLedgerEntry confirmations */
        confirmations?: (number|null);

        /** SharedLedgerEntry confirmerPubkeys */
        confirmerPubkeys?: (Uint8Array[]|null);
    }

    /** Represents a SharedLedgerEntry. */
    class SharedLedgerEntry implements ISharedLedgerEntry {

        /**
         * Constructs a new SharedLedgerEntry.
         * @param [properties] Properties to set
         */
        constructor(properties?: magic.ISharedLedgerEntry);

        /** SharedLedgerEntry index. */
        public index: (number|Long);

        /** SharedLedgerEntry prevHash. */
        public prevHash: Uint8Array;

        /** SharedLedgerEntry hash. */
        public hash: Uint8Array;

        /** SharedLedgerEntry data. */
        public data: Uint8Array;

        /** SharedLedgerEntry submitterPubkey. */
        public submitterPubkey: Uint8Array;

        /** SharedLedgerEntry signature. */
        public signature: Uint8Array;

        /** SharedLedgerEntry timestamp. */
        public timestamp: (number|Long);

        /** SharedLedgerEntry confirmations. */
        public confirmations: number;

        /** SharedLedgerEntry confirmerPubkeys. */
        public confirmerPubkeys: Uint8Array[];

        /**
         * Creates a new SharedLedgerEntry instance using the specified properties.
         * @param [properties] Properties to set
         * @returns SharedLedgerEntry instance
         */
        public static create(properties?: magic.ISharedLedgerEntry): magic.SharedLedgerEntry;

        /**
         * Encodes the specified SharedLedgerEntry message. Does not implicitly {@link magic.SharedLedgerEntry.verify|verify} messages.
         * @param message SharedLedgerEntry message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: magic.ISharedLedgerEntry, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified SharedLedgerEntry message, length delimited. Does not implicitly {@link magic.SharedLedgerEntry.verify|verify} messages.
         * @param message SharedLedgerEntry message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: magic.ISharedLedgerEntry, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a SharedLedgerEntry message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns SharedLedgerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): magic.SharedLedgerEntry;

        /**
         * Decodes a SharedLedgerEntry message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns SharedLedgerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): magic.SharedLedgerEntry;

        /**
         * Verifies a SharedLedgerEntry message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a SharedLedgerEntry message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns SharedLedgerEntry
         */
        public static fromObject(object: { [k: string]: any }): magic.SharedLedgerEntry;

        /**
         * Creates a plain object from a SharedLedgerEntry message. Also converts values to other types if specified.
         * @param message SharedLedgerEntry
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: magic.SharedLedgerEntry, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this SharedLedgerEntry to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for SharedLedgerEntry
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a PeerInfo. */
    interface IPeerInfo {

        /** PeerInfo peerId */
        peerId?: (Uint8Array|null);

        /** PeerInfo pubkey */
        pubkey?: (Uint8Array|null);

        /** PeerInfo multiaddrs */
        multiaddrs?: (string[]|null);

        /** PeerInfo offeredTags */
        offeredTags?: (string[]|null);

        /** PeerInfo lastSeen */
        lastSeen?: (number|Long|null);
    }

    /** Represents a PeerInfo. */
    class PeerInfo implements IPeerInfo {

        /**
         * Constructs a new PeerInfo.
         * @param [properties] Properties to set
         */
        constructor(properties?: magic.IPeerInfo);

        /** PeerInfo peerId. */
        public peerId: Uint8Array;

        /** PeerInfo pubkey. */
        public pubkey: Uint8Array;

        /** PeerInfo multiaddrs. */
        public multiaddrs: string[];

        /** PeerInfo offeredTags. */
        public offeredTags: string[];

        /** PeerInfo lastSeen. */
        public lastSeen: (number|Long);

        /**
         * Creates a new PeerInfo instance using the specified properties.
         * @param [properties] Properties to set
         * @returns PeerInfo instance
         */
        public static create(properties?: magic.IPeerInfo): magic.PeerInfo;

        /**
         * Encodes the specified PeerInfo message. Does not implicitly {@link magic.PeerInfo.verify|verify} messages.
         * @param message PeerInfo message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: magic.IPeerInfo, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified PeerInfo message, length delimited. Does not implicitly {@link magic.PeerInfo.verify|verify} messages.
         * @param message PeerInfo message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: magic.IPeerInfo, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a PeerInfo message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns PeerInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): magic.PeerInfo;

        /**
         * Decodes a PeerInfo message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns PeerInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): magic.PeerInfo;

        /**
         * Verifies a PeerInfo message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a PeerInfo message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns PeerInfo
         */
        public static fromObject(object: { [k: string]: any }): magic.PeerInfo;

        /**
         * Creates a plain object from a PeerInfo message. Also converts values to other types if specified.
         * @param message PeerInfo
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: magic.PeerInfo, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this PeerInfo to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for PeerInfo
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a PeerExchange. */
    interface IPeerExchange {

        /** PeerExchange peers */
        peers?: (magic.IPeerInfo[]|null);
    }

    /** Represents a PeerExchange. */
    class PeerExchange implements IPeerExchange {

        /**
         * Constructs a new PeerExchange.
         * @param [properties] Properties to set
         */
        constructor(properties?: magic.IPeerExchange);

        /** PeerExchange peers. */
        public peers: magic.IPeerInfo[];

        /**
         * Creates a new PeerExchange instance using the specified properties.
         * @param [properties] Properties to set
         * @returns PeerExchange instance
         */
        public static create(properties?: magic.IPeerExchange): magic.PeerExchange;

        /**
         * Encodes the specified PeerExchange message. Does not implicitly {@link magic.PeerExchange.verify|verify} messages.
         * @param message PeerExchange message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: magic.IPeerExchange, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified PeerExchange message, length delimited. Does not implicitly {@link magic.PeerExchange.verify|verify} messages.
         * @param message PeerExchange message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: magic.IPeerExchange, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a PeerExchange message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns PeerExchange
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): magic.PeerExchange;

        /**
         * Decodes a PeerExchange message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns PeerExchange
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): magic.PeerExchange;

        /**
         * Verifies a PeerExchange message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a PeerExchange message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns PeerExchange
         */
        public static fromObject(object: { [k: string]: any }): magic.PeerExchange;

        /**
         * Creates a plain object from a PeerExchange message. Also converts values to other types if specified.
         * @param message PeerExchange
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: magic.PeerExchange, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this PeerExchange to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for PeerExchange
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }
}
