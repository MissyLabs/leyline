/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
import * as $protobuf from "protobufjs/minimal";

// Common aliases
const $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

// Exported root namespace
const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

export const magic = $root.magic = (() => {

    /**
     * Namespace magic.
     * @exports magic
     * @namespace
     */
    const magic = {};

    magic.MagicMessage = (function() {

        /**
         * Properties of a MagicMessage.
         * @memberof magic
         * @interface IMagicMessage
         * @property {Uint8Array|null} [id] MagicMessage id
         * @property {Uint8Array|null} [senderPubkey] MagicMessage senderPubkey
         * @property {Uint8Array|null} [signature] MagicMessage signature
         * @property {Array.<string>|null} [tags] MagicMessage tags
         * @property {Uint8Array|null} [payload] MagicMessage payload
         * @property {number|Long|null} [timestamp] MagicMessage timestamp
         * @property {Uint8Array|null} [nonce] MagicMessage nonce
         * @property {magic.MessageType|null} [type] MagicMessage type
         * @property {number|null} [ttl] MagicMessage ttl
         */

        /**
         * Constructs a new MagicMessage.
         * @memberof magic
         * @classdesc Represents a MagicMessage.
         * @implements IMagicMessage
         * @constructor
         * @param {magic.IMagicMessage=} [properties] Properties to set
         */
        function MagicMessage(properties) {
            this.tags = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * MagicMessage id.
         * @member {Uint8Array} id
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.id = $util.newBuffer([]);

        /**
         * MagicMessage senderPubkey.
         * @member {Uint8Array} senderPubkey
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.senderPubkey = $util.newBuffer([]);

        /**
         * MagicMessage signature.
         * @member {Uint8Array} signature
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.signature = $util.newBuffer([]);

        /**
         * MagicMessage tags.
         * @member {Array.<string>} tags
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.tags = $util.emptyArray;

        /**
         * MagicMessage payload.
         * @member {Uint8Array} payload
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.payload = $util.newBuffer([]);

        /**
         * MagicMessage timestamp.
         * @member {number|Long} timestamp
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.timestamp = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * MagicMessage nonce.
         * @member {Uint8Array} nonce
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.nonce = $util.newBuffer([]);

        /**
         * MagicMessage type.
         * @member {magic.MessageType} type
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.type = 0;

        /**
         * MagicMessage ttl.
         * @member {number} ttl
         * @memberof magic.MagicMessage
         * @instance
         */
        MagicMessage.prototype.ttl = 0;

        /**
         * Creates a new MagicMessage instance using the specified properties.
         * @function create
         * @memberof magic.MagicMessage
         * @static
         * @param {magic.IMagicMessage=} [properties] Properties to set
         * @returns {magic.MagicMessage} MagicMessage instance
         */
        MagicMessage.create = function create(properties) {
            return new MagicMessage(properties);
        };

        /**
         * Encodes the specified MagicMessage message. Does not implicitly {@link magic.MagicMessage.verify|verify} messages.
         * @function encode
         * @memberof magic.MagicMessage
         * @static
         * @param {magic.IMagicMessage} message MagicMessage message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MagicMessage.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.id);
            if (message.senderPubkey != null && Object.hasOwnProperty.call(message, "senderPubkey"))
                writer.uint32(/* id 2, wireType 2 =*/18).bytes(message.senderPubkey);
            if (message.signature != null && Object.hasOwnProperty.call(message, "signature"))
                writer.uint32(/* id 3, wireType 2 =*/26).bytes(message.signature);
            if (message.tags != null && message.tags.length)
                for (let i = 0; i < message.tags.length; ++i)
                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.tags[i]);
            if (message.payload != null && Object.hasOwnProperty.call(message, "payload"))
                writer.uint32(/* id 5, wireType 2 =*/42).bytes(message.payload);
            if (message.timestamp != null && Object.hasOwnProperty.call(message, "timestamp"))
                writer.uint32(/* id 6, wireType 0 =*/48).uint64(message.timestamp);
            if (message.nonce != null && Object.hasOwnProperty.call(message, "nonce"))
                writer.uint32(/* id 7, wireType 2 =*/58).bytes(message.nonce);
            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                writer.uint32(/* id 8, wireType 0 =*/64).int32(message.type);
            if (message.ttl != null && Object.hasOwnProperty.call(message, "ttl"))
                writer.uint32(/* id 9, wireType 0 =*/72).uint32(message.ttl);
            return writer;
        };

        /**
         * Encodes the specified MagicMessage message, length delimited. Does not implicitly {@link magic.MagicMessage.verify|verify} messages.
         * @function encodeDelimited
         * @memberof magic.MagicMessage
         * @static
         * @param {magic.IMagicMessage} message MagicMessage message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        MagicMessage.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a MagicMessage message from the specified reader or buffer.
         * @function decode
         * @memberof magic.MagicMessage
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {magic.MagicMessage} MagicMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MagicMessage.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.magic.MagicMessage();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.id = reader.bytes();
                        break;
                    }
                case 2: {
                        message.senderPubkey = reader.bytes();
                        break;
                    }
                case 3: {
                        message.signature = reader.bytes();
                        break;
                    }
                case 4: {
                        if (!(message.tags && message.tags.length))
                            message.tags = [];
                        message.tags.push(reader.string());
                        break;
                    }
                case 5: {
                        message.payload = reader.bytes();
                        break;
                    }
                case 6: {
                        message.timestamp = reader.uint64();
                        break;
                    }
                case 7: {
                        message.nonce = reader.bytes();
                        break;
                    }
                case 8: {
                        message.type = reader.int32();
                        break;
                    }
                case 9: {
                        message.ttl = reader.uint32();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a MagicMessage message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof magic.MagicMessage
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {magic.MagicMessage} MagicMessage
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        MagicMessage.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a MagicMessage message.
         * @function verify
         * @memberof magic.MagicMessage
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        MagicMessage.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.id != null && message.hasOwnProperty("id"))
                if (!(message.id && typeof message.id.length === "number" || $util.isString(message.id)))
                    return "id: buffer expected";
            if (message.senderPubkey != null && message.hasOwnProperty("senderPubkey"))
                if (!(message.senderPubkey && typeof message.senderPubkey.length === "number" || $util.isString(message.senderPubkey)))
                    return "senderPubkey: buffer expected";
            if (message.signature != null && message.hasOwnProperty("signature"))
                if (!(message.signature && typeof message.signature.length === "number" || $util.isString(message.signature)))
                    return "signature: buffer expected";
            if (message.tags != null && message.hasOwnProperty("tags")) {
                if (!Array.isArray(message.tags))
                    return "tags: array expected";
                for (let i = 0; i < message.tags.length; ++i)
                    if (!$util.isString(message.tags[i]))
                        return "tags: string[] expected";
            }
            if (message.payload != null && message.hasOwnProperty("payload"))
                if (!(message.payload && typeof message.payload.length === "number" || $util.isString(message.payload)))
                    return "payload: buffer expected";
            if (message.timestamp != null && message.hasOwnProperty("timestamp"))
                if (!$util.isInteger(message.timestamp) && !(message.timestamp && $util.isInteger(message.timestamp.low) && $util.isInteger(message.timestamp.high)))
                    return "timestamp: integer|Long expected";
            if (message.nonce != null && message.hasOwnProperty("nonce"))
                if (!(message.nonce && typeof message.nonce.length === "number" || $util.isString(message.nonce)))
                    return "nonce: buffer expected";
            if (message.type != null && message.hasOwnProperty("type"))
                switch (message.type) {
                default:
                    return "type: enum value expected";
                case 0:
                case 1:
                case 2:
                case 3:
                case 4:
                case 5:
                    break;
                }
            if (message.ttl != null && message.hasOwnProperty("ttl"))
                if (!$util.isInteger(message.ttl))
                    return "ttl: integer expected";
            return null;
        };

        /**
         * Creates a MagicMessage message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof magic.MagicMessage
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {magic.MagicMessage} MagicMessage
         */
        MagicMessage.fromObject = function fromObject(object) {
            if (object instanceof $root.magic.MagicMessage)
                return object;
            let message = new $root.magic.MagicMessage();
            if (object.id != null)
                if (typeof object.id === "string")
                    $util.base64.decode(object.id, message.id = $util.newBuffer($util.base64.length(object.id)), 0);
                else if (object.id.length >= 0)
                    message.id = object.id;
            if (object.senderPubkey != null)
                if (typeof object.senderPubkey === "string")
                    $util.base64.decode(object.senderPubkey, message.senderPubkey = $util.newBuffer($util.base64.length(object.senderPubkey)), 0);
                else if (object.senderPubkey.length >= 0)
                    message.senderPubkey = object.senderPubkey;
            if (object.signature != null)
                if (typeof object.signature === "string")
                    $util.base64.decode(object.signature, message.signature = $util.newBuffer($util.base64.length(object.signature)), 0);
                else if (object.signature.length >= 0)
                    message.signature = object.signature;
            if (object.tags) {
                if (!Array.isArray(object.tags))
                    throw TypeError(".magic.MagicMessage.tags: array expected");
                message.tags = [];
                for (let i = 0; i < object.tags.length; ++i)
                    message.tags[i] = String(object.tags[i]);
            }
            if (object.payload != null)
                if (typeof object.payload === "string")
                    $util.base64.decode(object.payload, message.payload = $util.newBuffer($util.base64.length(object.payload)), 0);
                else if (object.payload.length >= 0)
                    message.payload = object.payload;
            if (object.timestamp != null)
                if ($util.Long)
                    (message.timestamp = $util.Long.fromValue(object.timestamp)).unsigned = true;
                else if (typeof object.timestamp === "string")
                    message.timestamp = parseInt(object.timestamp, 10);
                else if (typeof object.timestamp === "number")
                    message.timestamp = object.timestamp;
                else if (typeof object.timestamp === "object")
                    message.timestamp = new $util.LongBits(object.timestamp.low >>> 0, object.timestamp.high >>> 0).toNumber(true);
            if (object.nonce != null)
                if (typeof object.nonce === "string")
                    $util.base64.decode(object.nonce, message.nonce = $util.newBuffer($util.base64.length(object.nonce)), 0);
                else if (object.nonce.length >= 0)
                    message.nonce = object.nonce;
            switch (object.type) {
            default:
                if (typeof object.type === "number") {
                    message.type = object.type;
                    break;
                }
                break;
            case "MESSAGE_TYPE_UNSPECIFIED":
            case 0:
                message.type = 0;
                break;
            case "MESSAGE_TYPE_BROADCAST":
            case 1:
                message.type = 1;
                break;
            case "MESSAGE_TYPE_DIRECT":
            case 2:
                message.type = 2;
                break;
            case "MESSAGE_TYPE_ADVERTISE":
            case 3:
                message.type = 3;
                break;
            case "MESSAGE_TYPE_DISCOVER":
            case 4:
                message.type = 4;
                break;
            case "MESSAGE_TYPE_DISCOVER_RESPONSE":
            case 5:
                message.type = 5;
                break;
            }
            if (object.ttl != null)
                message.ttl = object.ttl >>> 0;
            return message;
        };

        /**
         * Creates a plain object from a MagicMessage message. Also converts values to other types if specified.
         * @function toObject
         * @memberof magic.MagicMessage
         * @static
         * @param {magic.MagicMessage} message MagicMessage
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        MagicMessage.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.tags = [];
            if (options.defaults) {
                if (options.bytes === String)
                    object.id = "";
                else {
                    object.id = [];
                    if (options.bytes !== Array)
                        object.id = $util.newBuffer(object.id);
                }
                if (options.bytes === String)
                    object.senderPubkey = "";
                else {
                    object.senderPubkey = [];
                    if (options.bytes !== Array)
                        object.senderPubkey = $util.newBuffer(object.senderPubkey);
                }
                if (options.bytes === String)
                    object.signature = "";
                else {
                    object.signature = [];
                    if (options.bytes !== Array)
                        object.signature = $util.newBuffer(object.signature);
                }
                if (options.bytes === String)
                    object.payload = "";
                else {
                    object.payload = [];
                    if (options.bytes !== Array)
                        object.payload = $util.newBuffer(object.payload);
                }
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.timestamp = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.timestamp = options.longs === String ? "0" : 0;
                if (options.bytes === String)
                    object.nonce = "";
                else {
                    object.nonce = [];
                    if (options.bytes !== Array)
                        object.nonce = $util.newBuffer(object.nonce);
                }
                object.type = options.enums === String ? "MESSAGE_TYPE_UNSPECIFIED" : 0;
                object.ttl = 0;
            }
            if (message.id != null && message.hasOwnProperty("id"))
                object.id = options.bytes === String ? $util.base64.encode(message.id, 0, message.id.length) : options.bytes === Array ? Array.prototype.slice.call(message.id) : message.id;
            if (message.senderPubkey != null && message.hasOwnProperty("senderPubkey"))
                object.senderPubkey = options.bytes === String ? $util.base64.encode(message.senderPubkey, 0, message.senderPubkey.length) : options.bytes === Array ? Array.prototype.slice.call(message.senderPubkey) : message.senderPubkey;
            if (message.signature != null && message.hasOwnProperty("signature"))
                object.signature = options.bytes === String ? $util.base64.encode(message.signature, 0, message.signature.length) : options.bytes === Array ? Array.prototype.slice.call(message.signature) : message.signature;
            if (message.tags && message.tags.length) {
                object.tags = [];
                for (let j = 0; j < message.tags.length; ++j)
                    object.tags[j] = message.tags[j];
            }
            if (message.payload != null && message.hasOwnProperty("payload"))
                object.payload = options.bytes === String ? $util.base64.encode(message.payload, 0, message.payload.length) : options.bytes === Array ? Array.prototype.slice.call(message.payload) : message.payload;
            if (message.timestamp != null && message.hasOwnProperty("timestamp"))
                if (typeof message.timestamp === "number")
                    object.timestamp = options.longs === String ? String(message.timestamp) : message.timestamp;
                else
                    object.timestamp = options.longs === String ? $util.Long.prototype.toString.call(message.timestamp) : options.longs === Number ? new $util.LongBits(message.timestamp.low >>> 0, message.timestamp.high >>> 0).toNumber(true) : message.timestamp;
            if (message.nonce != null && message.hasOwnProperty("nonce"))
                object.nonce = options.bytes === String ? $util.base64.encode(message.nonce, 0, message.nonce.length) : options.bytes === Array ? Array.prototype.slice.call(message.nonce) : message.nonce;
            if (message.type != null && message.hasOwnProperty("type"))
                object.type = options.enums === String ? $root.magic.MessageType[message.type] === undefined ? message.type : $root.magic.MessageType[message.type] : message.type;
            if (message.ttl != null && message.hasOwnProperty("ttl"))
                object.ttl = message.ttl;
            return object;
        };

        /**
         * Converts this MagicMessage to JSON.
         * @function toJSON
         * @memberof magic.MagicMessage
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        MagicMessage.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for MagicMessage
         * @function getTypeUrl
         * @memberof magic.MagicMessage
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        MagicMessage.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/magic.MagicMessage";
        };

        return MagicMessage;
    })();

    /**
     * MessageType enum.
     * @name magic.MessageType
     * @enum {number}
     * @property {number} MESSAGE_TYPE_UNSPECIFIED=0 MESSAGE_TYPE_UNSPECIFIED value
     * @property {number} MESSAGE_TYPE_BROADCAST=1 MESSAGE_TYPE_BROADCAST value
     * @property {number} MESSAGE_TYPE_DIRECT=2 MESSAGE_TYPE_DIRECT value
     * @property {number} MESSAGE_TYPE_ADVERTISE=3 MESSAGE_TYPE_ADVERTISE value
     * @property {number} MESSAGE_TYPE_DISCOVER=4 MESSAGE_TYPE_DISCOVER value
     * @property {number} MESSAGE_TYPE_DISCOVER_RESPONSE=5 MESSAGE_TYPE_DISCOVER_RESPONSE value
     */
    magic.MessageType = (function() {
        const valuesById = {}, values = Object.create(valuesById);
        values[valuesById[0] = "MESSAGE_TYPE_UNSPECIFIED"] = 0;
        values[valuesById[1] = "MESSAGE_TYPE_BROADCAST"] = 1;
        values[valuesById[2] = "MESSAGE_TYPE_DIRECT"] = 2;
        values[valuesById[3] = "MESSAGE_TYPE_ADVERTISE"] = 3;
        values[valuesById[4] = "MESSAGE_TYPE_DISCOVER"] = 4;
        values[valuesById[5] = "MESSAGE_TYPE_DISCOVER_RESPONSE"] = 5;
        return values;
    })();

    magic.LedgerEntry = (function() {

        /**
         * Properties of a LedgerEntry.
         * @memberof magic
         * @interface ILedgerEntry
         * @property {number|Long|null} [index] LedgerEntry index
         * @property {Uint8Array|null} [prevHash] LedgerEntry prevHash
         * @property {Uint8Array|null} [hash] LedgerEntry hash
         * @property {magic.IMagicMessage|null} [message] LedgerEntry message
         * @property {number|Long|null} [recordedAt] LedgerEntry recordedAt
         * @property {magic.LedgerAction|null} [action] LedgerEntry action
         */

        /**
         * Constructs a new LedgerEntry.
         * @memberof magic
         * @classdesc Represents a LedgerEntry.
         * @implements ILedgerEntry
         * @constructor
         * @param {magic.ILedgerEntry=} [properties] Properties to set
         */
        function LedgerEntry(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * LedgerEntry index.
         * @member {number|Long} index
         * @memberof magic.LedgerEntry
         * @instance
         */
        LedgerEntry.prototype.index = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * LedgerEntry prevHash.
         * @member {Uint8Array} prevHash
         * @memberof magic.LedgerEntry
         * @instance
         */
        LedgerEntry.prototype.prevHash = $util.newBuffer([]);

        /**
         * LedgerEntry hash.
         * @member {Uint8Array} hash
         * @memberof magic.LedgerEntry
         * @instance
         */
        LedgerEntry.prototype.hash = $util.newBuffer([]);

        /**
         * LedgerEntry message.
         * @member {magic.IMagicMessage|null|undefined} message
         * @memberof magic.LedgerEntry
         * @instance
         */
        LedgerEntry.prototype.message = null;

        /**
         * LedgerEntry recordedAt.
         * @member {number|Long} recordedAt
         * @memberof magic.LedgerEntry
         * @instance
         */
        LedgerEntry.prototype.recordedAt = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * LedgerEntry action.
         * @member {magic.LedgerAction} action
         * @memberof magic.LedgerEntry
         * @instance
         */
        LedgerEntry.prototype.action = 0;

        /**
         * Creates a new LedgerEntry instance using the specified properties.
         * @function create
         * @memberof magic.LedgerEntry
         * @static
         * @param {magic.ILedgerEntry=} [properties] Properties to set
         * @returns {magic.LedgerEntry} LedgerEntry instance
         */
        LedgerEntry.create = function create(properties) {
            return new LedgerEntry(properties);
        };

        /**
         * Encodes the specified LedgerEntry message. Does not implicitly {@link magic.LedgerEntry.verify|verify} messages.
         * @function encode
         * @memberof magic.LedgerEntry
         * @static
         * @param {magic.ILedgerEntry} message LedgerEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        LedgerEntry.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.index != null && Object.hasOwnProperty.call(message, "index"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint64(message.index);
            if (message.prevHash != null && Object.hasOwnProperty.call(message, "prevHash"))
                writer.uint32(/* id 2, wireType 2 =*/18).bytes(message.prevHash);
            if (message.hash != null && Object.hasOwnProperty.call(message, "hash"))
                writer.uint32(/* id 3, wireType 2 =*/26).bytes(message.hash);
            if (message.message != null && Object.hasOwnProperty.call(message, "message"))
                $root.magic.MagicMessage.encode(message.message, writer.uint32(/* id 4, wireType 2 =*/34).fork()).ldelim();
            if (message.recordedAt != null && Object.hasOwnProperty.call(message, "recordedAt"))
                writer.uint32(/* id 5, wireType 0 =*/40).uint64(message.recordedAt);
            if (message.action != null && Object.hasOwnProperty.call(message, "action"))
                writer.uint32(/* id 6, wireType 0 =*/48).int32(message.action);
            return writer;
        };

        /**
         * Encodes the specified LedgerEntry message, length delimited. Does not implicitly {@link magic.LedgerEntry.verify|verify} messages.
         * @function encodeDelimited
         * @memberof magic.LedgerEntry
         * @static
         * @param {magic.ILedgerEntry} message LedgerEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        LedgerEntry.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a LedgerEntry message from the specified reader or buffer.
         * @function decode
         * @memberof magic.LedgerEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {magic.LedgerEntry} LedgerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        LedgerEntry.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.magic.LedgerEntry();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.index = reader.uint64();
                        break;
                    }
                case 2: {
                        message.prevHash = reader.bytes();
                        break;
                    }
                case 3: {
                        message.hash = reader.bytes();
                        break;
                    }
                case 4: {
                        message.message = $root.magic.MagicMessage.decode(reader, reader.uint32());
                        break;
                    }
                case 5: {
                        message.recordedAt = reader.uint64();
                        break;
                    }
                case 6: {
                        message.action = reader.int32();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a LedgerEntry message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof magic.LedgerEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {magic.LedgerEntry} LedgerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        LedgerEntry.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a LedgerEntry message.
         * @function verify
         * @memberof magic.LedgerEntry
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        LedgerEntry.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.index != null && message.hasOwnProperty("index"))
                if (!$util.isInteger(message.index) && !(message.index && $util.isInteger(message.index.low) && $util.isInteger(message.index.high)))
                    return "index: integer|Long expected";
            if (message.prevHash != null && message.hasOwnProperty("prevHash"))
                if (!(message.prevHash && typeof message.prevHash.length === "number" || $util.isString(message.prevHash)))
                    return "prevHash: buffer expected";
            if (message.hash != null && message.hasOwnProperty("hash"))
                if (!(message.hash && typeof message.hash.length === "number" || $util.isString(message.hash)))
                    return "hash: buffer expected";
            if (message.message != null && message.hasOwnProperty("message")) {
                let error = $root.magic.MagicMessage.verify(message.message);
                if (error)
                    return "message." + error;
            }
            if (message.recordedAt != null && message.hasOwnProperty("recordedAt"))
                if (!$util.isInteger(message.recordedAt) && !(message.recordedAt && $util.isInteger(message.recordedAt.low) && $util.isInteger(message.recordedAt.high)))
                    return "recordedAt: integer|Long expected";
            if (message.action != null && message.hasOwnProperty("action"))
                switch (message.action) {
                default:
                    return "action: enum value expected";
                case 0:
                case 1:
                case 2:
                case 3:
                case 4:
                    break;
                }
            return null;
        };

        /**
         * Creates a LedgerEntry message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof magic.LedgerEntry
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {magic.LedgerEntry} LedgerEntry
         */
        LedgerEntry.fromObject = function fromObject(object) {
            if (object instanceof $root.magic.LedgerEntry)
                return object;
            let message = new $root.magic.LedgerEntry();
            if (object.index != null)
                if ($util.Long)
                    (message.index = $util.Long.fromValue(object.index)).unsigned = true;
                else if (typeof object.index === "string")
                    message.index = parseInt(object.index, 10);
                else if (typeof object.index === "number")
                    message.index = object.index;
                else if (typeof object.index === "object")
                    message.index = new $util.LongBits(object.index.low >>> 0, object.index.high >>> 0).toNumber(true);
            if (object.prevHash != null)
                if (typeof object.prevHash === "string")
                    $util.base64.decode(object.prevHash, message.prevHash = $util.newBuffer($util.base64.length(object.prevHash)), 0);
                else if (object.prevHash.length >= 0)
                    message.prevHash = object.prevHash;
            if (object.hash != null)
                if (typeof object.hash === "string")
                    $util.base64.decode(object.hash, message.hash = $util.newBuffer($util.base64.length(object.hash)), 0);
                else if (object.hash.length >= 0)
                    message.hash = object.hash;
            if (object.message != null) {
                if (typeof object.message !== "object")
                    throw TypeError(".magic.LedgerEntry.message: object expected");
                message.message = $root.magic.MagicMessage.fromObject(object.message);
            }
            if (object.recordedAt != null)
                if ($util.Long)
                    (message.recordedAt = $util.Long.fromValue(object.recordedAt)).unsigned = true;
                else if (typeof object.recordedAt === "string")
                    message.recordedAt = parseInt(object.recordedAt, 10);
                else if (typeof object.recordedAt === "number")
                    message.recordedAt = object.recordedAt;
                else if (typeof object.recordedAt === "object")
                    message.recordedAt = new $util.LongBits(object.recordedAt.low >>> 0, object.recordedAt.high >>> 0).toNumber(true);
            switch (object.action) {
            default:
                if (typeof object.action === "number") {
                    message.action = object.action;
                    break;
                }
                break;
            case "LEDGER_ACTION_UNSPECIFIED":
            case 0:
                message.action = 0;
                break;
            case "LEDGER_ACTION_SENT":
            case 1:
                message.action = 1;
                break;
            case "LEDGER_ACTION_RECEIVED":
            case 2:
                message.action = 2;
                break;
            case "LEDGER_ACTION_BLOCKED":
            case 3:
                message.action = 3;
                break;
            case "LEDGER_ACTION_RELAYED":
            case 4:
                message.action = 4;
                break;
            }
            return message;
        };

        /**
         * Creates a plain object from a LedgerEntry message. Also converts values to other types if specified.
         * @function toObject
         * @memberof magic.LedgerEntry
         * @static
         * @param {magic.LedgerEntry} message LedgerEntry
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        LedgerEntry.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.index = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.index = options.longs === String ? "0" : 0;
                if (options.bytes === String)
                    object.prevHash = "";
                else {
                    object.prevHash = [];
                    if (options.bytes !== Array)
                        object.prevHash = $util.newBuffer(object.prevHash);
                }
                if (options.bytes === String)
                    object.hash = "";
                else {
                    object.hash = [];
                    if (options.bytes !== Array)
                        object.hash = $util.newBuffer(object.hash);
                }
                object.message = null;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.recordedAt = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.recordedAt = options.longs === String ? "0" : 0;
                object.action = options.enums === String ? "LEDGER_ACTION_UNSPECIFIED" : 0;
            }
            if (message.index != null && message.hasOwnProperty("index"))
                if (typeof message.index === "number")
                    object.index = options.longs === String ? String(message.index) : message.index;
                else
                    object.index = options.longs === String ? $util.Long.prototype.toString.call(message.index) : options.longs === Number ? new $util.LongBits(message.index.low >>> 0, message.index.high >>> 0).toNumber(true) : message.index;
            if (message.prevHash != null && message.hasOwnProperty("prevHash"))
                object.prevHash = options.bytes === String ? $util.base64.encode(message.prevHash, 0, message.prevHash.length) : options.bytes === Array ? Array.prototype.slice.call(message.prevHash) : message.prevHash;
            if (message.hash != null && message.hasOwnProperty("hash"))
                object.hash = options.bytes === String ? $util.base64.encode(message.hash, 0, message.hash.length) : options.bytes === Array ? Array.prototype.slice.call(message.hash) : message.hash;
            if (message.message != null && message.hasOwnProperty("message"))
                object.message = $root.magic.MagicMessage.toObject(message.message, options);
            if (message.recordedAt != null && message.hasOwnProperty("recordedAt"))
                if (typeof message.recordedAt === "number")
                    object.recordedAt = options.longs === String ? String(message.recordedAt) : message.recordedAt;
                else
                    object.recordedAt = options.longs === String ? $util.Long.prototype.toString.call(message.recordedAt) : options.longs === Number ? new $util.LongBits(message.recordedAt.low >>> 0, message.recordedAt.high >>> 0).toNumber(true) : message.recordedAt;
            if (message.action != null && message.hasOwnProperty("action"))
                object.action = options.enums === String ? $root.magic.LedgerAction[message.action] === undefined ? message.action : $root.magic.LedgerAction[message.action] : message.action;
            return object;
        };

        /**
         * Converts this LedgerEntry to JSON.
         * @function toJSON
         * @memberof magic.LedgerEntry
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        LedgerEntry.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for LedgerEntry
         * @function getTypeUrl
         * @memberof magic.LedgerEntry
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        LedgerEntry.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/magic.LedgerEntry";
        };

        return LedgerEntry;
    })();

    /**
     * LedgerAction enum.
     * @name magic.LedgerAction
     * @enum {number}
     * @property {number} LEDGER_ACTION_UNSPECIFIED=0 LEDGER_ACTION_UNSPECIFIED value
     * @property {number} LEDGER_ACTION_SENT=1 LEDGER_ACTION_SENT value
     * @property {number} LEDGER_ACTION_RECEIVED=2 LEDGER_ACTION_RECEIVED value
     * @property {number} LEDGER_ACTION_BLOCKED=3 LEDGER_ACTION_BLOCKED value
     * @property {number} LEDGER_ACTION_RELAYED=4 LEDGER_ACTION_RELAYED value
     */
    magic.LedgerAction = (function() {
        const valuesById = {}, values = Object.create(valuesById);
        values[valuesById[0] = "LEDGER_ACTION_UNSPECIFIED"] = 0;
        values[valuesById[1] = "LEDGER_ACTION_SENT"] = 1;
        values[valuesById[2] = "LEDGER_ACTION_RECEIVED"] = 2;
        values[valuesById[3] = "LEDGER_ACTION_BLOCKED"] = 3;
        values[valuesById[4] = "LEDGER_ACTION_RELAYED"] = 4;
        return values;
    })();

    magic.SharedLedgerEntry = (function() {

        /**
         * Properties of a SharedLedgerEntry.
         * @memberof magic
         * @interface ISharedLedgerEntry
         * @property {number|Long|null} [index] SharedLedgerEntry index
         * @property {Uint8Array|null} [prevHash] SharedLedgerEntry prevHash
         * @property {Uint8Array|null} [hash] SharedLedgerEntry hash
         * @property {Uint8Array|null} [data] SharedLedgerEntry data
         * @property {Uint8Array|null} [submitterPubkey] SharedLedgerEntry submitterPubkey
         * @property {Uint8Array|null} [signature] SharedLedgerEntry signature
         * @property {number|Long|null} [timestamp] SharedLedgerEntry timestamp
         * @property {number|null} [confirmations] SharedLedgerEntry confirmations
         * @property {Array.<Uint8Array>|null} [confirmerPubkeys] SharedLedgerEntry confirmerPubkeys
         */

        /**
         * Constructs a new SharedLedgerEntry.
         * @memberof magic
         * @classdesc Represents a SharedLedgerEntry.
         * @implements ISharedLedgerEntry
         * @constructor
         * @param {magic.ISharedLedgerEntry=} [properties] Properties to set
         */
        function SharedLedgerEntry(properties) {
            this.confirmerPubkeys = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * SharedLedgerEntry index.
         * @member {number|Long} index
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.index = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * SharedLedgerEntry prevHash.
         * @member {Uint8Array} prevHash
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.prevHash = $util.newBuffer([]);

        /**
         * SharedLedgerEntry hash.
         * @member {Uint8Array} hash
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.hash = $util.newBuffer([]);

        /**
         * SharedLedgerEntry data.
         * @member {Uint8Array} data
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.data = $util.newBuffer([]);

        /**
         * SharedLedgerEntry submitterPubkey.
         * @member {Uint8Array} submitterPubkey
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.submitterPubkey = $util.newBuffer([]);

        /**
         * SharedLedgerEntry signature.
         * @member {Uint8Array} signature
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.signature = $util.newBuffer([]);

        /**
         * SharedLedgerEntry timestamp.
         * @member {number|Long} timestamp
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.timestamp = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * SharedLedgerEntry confirmations.
         * @member {number} confirmations
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.confirmations = 0;

        /**
         * SharedLedgerEntry confirmerPubkeys.
         * @member {Array.<Uint8Array>} confirmerPubkeys
         * @memberof magic.SharedLedgerEntry
         * @instance
         */
        SharedLedgerEntry.prototype.confirmerPubkeys = $util.emptyArray;

        /**
         * Creates a new SharedLedgerEntry instance using the specified properties.
         * @function create
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {magic.ISharedLedgerEntry=} [properties] Properties to set
         * @returns {magic.SharedLedgerEntry} SharedLedgerEntry instance
         */
        SharedLedgerEntry.create = function create(properties) {
            return new SharedLedgerEntry(properties);
        };

        /**
         * Encodes the specified SharedLedgerEntry message. Does not implicitly {@link magic.SharedLedgerEntry.verify|verify} messages.
         * @function encode
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {magic.ISharedLedgerEntry} message SharedLedgerEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SharedLedgerEntry.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.index != null && Object.hasOwnProperty.call(message, "index"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint64(message.index);
            if (message.prevHash != null && Object.hasOwnProperty.call(message, "prevHash"))
                writer.uint32(/* id 2, wireType 2 =*/18).bytes(message.prevHash);
            if (message.hash != null && Object.hasOwnProperty.call(message, "hash"))
                writer.uint32(/* id 3, wireType 2 =*/26).bytes(message.hash);
            if (message.data != null && Object.hasOwnProperty.call(message, "data"))
                writer.uint32(/* id 4, wireType 2 =*/34).bytes(message.data);
            if (message.submitterPubkey != null && Object.hasOwnProperty.call(message, "submitterPubkey"))
                writer.uint32(/* id 5, wireType 2 =*/42).bytes(message.submitterPubkey);
            if (message.signature != null && Object.hasOwnProperty.call(message, "signature"))
                writer.uint32(/* id 6, wireType 2 =*/50).bytes(message.signature);
            if (message.timestamp != null && Object.hasOwnProperty.call(message, "timestamp"))
                writer.uint32(/* id 7, wireType 0 =*/56).uint64(message.timestamp);
            if (message.confirmations != null && Object.hasOwnProperty.call(message, "confirmations"))
                writer.uint32(/* id 8, wireType 0 =*/64).uint32(message.confirmations);
            if (message.confirmerPubkeys != null && message.confirmerPubkeys.length)
                for (let i = 0; i < message.confirmerPubkeys.length; ++i)
                    writer.uint32(/* id 9, wireType 2 =*/74).bytes(message.confirmerPubkeys[i]);
            return writer;
        };

        /**
         * Encodes the specified SharedLedgerEntry message, length delimited. Does not implicitly {@link magic.SharedLedgerEntry.verify|verify} messages.
         * @function encodeDelimited
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {magic.ISharedLedgerEntry} message SharedLedgerEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SharedLedgerEntry.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a SharedLedgerEntry message from the specified reader or buffer.
         * @function decode
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {magic.SharedLedgerEntry} SharedLedgerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SharedLedgerEntry.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.magic.SharedLedgerEntry();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.index = reader.uint64();
                        break;
                    }
                case 2: {
                        message.prevHash = reader.bytes();
                        break;
                    }
                case 3: {
                        message.hash = reader.bytes();
                        break;
                    }
                case 4: {
                        message.data = reader.bytes();
                        break;
                    }
                case 5: {
                        message.submitterPubkey = reader.bytes();
                        break;
                    }
                case 6: {
                        message.signature = reader.bytes();
                        break;
                    }
                case 7: {
                        message.timestamp = reader.uint64();
                        break;
                    }
                case 8: {
                        message.confirmations = reader.uint32();
                        break;
                    }
                case 9: {
                        if (!(message.confirmerPubkeys && message.confirmerPubkeys.length))
                            message.confirmerPubkeys = [];
                        message.confirmerPubkeys.push(reader.bytes());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a SharedLedgerEntry message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {magic.SharedLedgerEntry} SharedLedgerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SharedLedgerEntry.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a SharedLedgerEntry message.
         * @function verify
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        SharedLedgerEntry.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.index != null && message.hasOwnProperty("index"))
                if (!$util.isInteger(message.index) && !(message.index && $util.isInteger(message.index.low) && $util.isInteger(message.index.high)))
                    return "index: integer|Long expected";
            if (message.prevHash != null && message.hasOwnProperty("prevHash"))
                if (!(message.prevHash && typeof message.prevHash.length === "number" || $util.isString(message.prevHash)))
                    return "prevHash: buffer expected";
            if (message.hash != null && message.hasOwnProperty("hash"))
                if (!(message.hash && typeof message.hash.length === "number" || $util.isString(message.hash)))
                    return "hash: buffer expected";
            if (message.data != null && message.hasOwnProperty("data"))
                if (!(message.data && typeof message.data.length === "number" || $util.isString(message.data)))
                    return "data: buffer expected";
            if (message.submitterPubkey != null && message.hasOwnProperty("submitterPubkey"))
                if (!(message.submitterPubkey && typeof message.submitterPubkey.length === "number" || $util.isString(message.submitterPubkey)))
                    return "submitterPubkey: buffer expected";
            if (message.signature != null && message.hasOwnProperty("signature"))
                if (!(message.signature && typeof message.signature.length === "number" || $util.isString(message.signature)))
                    return "signature: buffer expected";
            if (message.timestamp != null && message.hasOwnProperty("timestamp"))
                if (!$util.isInteger(message.timestamp) && !(message.timestamp && $util.isInteger(message.timestamp.low) && $util.isInteger(message.timestamp.high)))
                    return "timestamp: integer|Long expected";
            if (message.confirmations != null && message.hasOwnProperty("confirmations"))
                if (!$util.isInteger(message.confirmations))
                    return "confirmations: integer expected";
            if (message.confirmerPubkeys != null && message.hasOwnProperty("confirmerPubkeys")) {
                if (!Array.isArray(message.confirmerPubkeys))
                    return "confirmerPubkeys: array expected";
                for (let i = 0; i < message.confirmerPubkeys.length; ++i)
                    if (!(message.confirmerPubkeys[i] && typeof message.confirmerPubkeys[i].length === "number" || $util.isString(message.confirmerPubkeys[i])))
                        return "confirmerPubkeys: buffer[] expected";
            }
            return null;
        };

        /**
         * Creates a SharedLedgerEntry message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {magic.SharedLedgerEntry} SharedLedgerEntry
         */
        SharedLedgerEntry.fromObject = function fromObject(object) {
            if (object instanceof $root.magic.SharedLedgerEntry)
                return object;
            let message = new $root.magic.SharedLedgerEntry();
            if (object.index != null)
                if ($util.Long)
                    (message.index = $util.Long.fromValue(object.index)).unsigned = true;
                else if (typeof object.index === "string")
                    message.index = parseInt(object.index, 10);
                else if (typeof object.index === "number")
                    message.index = object.index;
                else if (typeof object.index === "object")
                    message.index = new $util.LongBits(object.index.low >>> 0, object.index.high >>> 0).toNumber(true);
            if (object.prevHash != null)
                if (typeof object.prevHash === "string")
                    $util.base64.decode(object.prevHash, message.prevHash = $util.newBuffer($util.base64.length(object.prevHash)), 0);
                else if (object.prevHash.length >= 0)
                    message.prevHash = object.prevHash;
            if (object.hash != null)
                if (typeof object.hash === "string")
                    $util.base64.decode(object.hash, message.hash = $util.newBuffer($util.base64.length(object.hash)), 0);
                else if (object.hash.length >= 0)
                    message.hash = object.hash;
            if (object.data != null)
                if (typeof object.data === "string")
                    $util.base64.decode(object.data, message.data = $util.newBuffer($util.base64.length(object.data)), 0);
                else if (object.data.length >= 0)
                    message.data = object.data;
            if (object.submitterPubkey != null)
                if (typeof object.submitterPubkey === "string")
                    $util.base64.decode(object.submitterPubkey, message.submitterPubkey = $util.newBuffer($util.base64.length(object.submitterPubkey)), 0);
                else if (object.submitterPubkey.length >= 0)
                    message.submitterPubkey = object.submitterPubkey;
            if (object.signature != null)
                if (typeof object.signature === "string")
                    $util.base64.decode(object.signature, message.signature = $util.newBuffer($util.base64.length(object.signature)), 0);
                else if (object.signature.length >= 0)
                    message.signature = object.signature;
            if (object.timestamp != null)
                if ($util.Long)
                    (message.timestamp = $util.Long.fromValue(object.timestamp)).unsigned = true;
                else if (typeof object.timestamp === "string")
                    message.timestamp = parseInt(object.timestamp, 10);
                else if (typeof object.timestamp === "number")
                    message.timestamp = object.timestamp;
                else if (typeof object.timestamp === "object")
                    message.timestamp = new $util.LongBits(object.timestamp.low >>> 0, object.timestamp.high >>> 0).toNumber(true);
            if (object.confirmations != null)
                message.confirmations = object.confirmations >>> 0;
            if (object.confirmerPubkeys) {
                if (!Array.isArray(object.confirmerPubkeys))
                    throw TypeError(".magic.SharedLedgerEntry.confirmerPubkeys: array expected");
                message.confirmerPubkeys = [];
                for (let i = 0; i < object.confirmerPubkeys.length; ++i)
                    if (typeof object.confirmerPubkeys[i] === "string")
                        $util.base64.decode(object.confirmerPubkeys[i], message.confirmerPubkeys[i] = $util.newBuffer($util.base64.length(object.confirmerPubkeys[i])), 0);
                    else if (object.confirmerPubkeys[i].length >= 0)
                        message.confirmerPubkeys[i] = object.confirmerPubkeys[i];
            }
            return message;
        };

        /**
         * Creates a plain object from a SharedLedgerEntry message. Also converts values to other types if specified.
         * @function toObject
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {magic.SharedLedgerEntry} message SharedLedgerEntry
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        SharedLedgerEntry.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.confirmerPubkeys = [];
            if (options.defaults) {
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.index = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.index = options.longs === String ? "0" : 0;
                if (options.bytes === String)
                    object.prevHash = "";
                else {
                    object.prevHash = [];
                    if (options.bytes !== Array)
                        object.prevHash = $util.newBuffer(object.prevHash);
                }
                if (options.bytes === String)
                    object.hash = "";
                else {
                    object.hash = [];
                    if (options.bytes !== Array)
                        object.hash = $util.newBuffer(object.hash);
                }
                if (options.bytes === String)
                    object.data = "";
                else {
                    object.data = [];
                    if (options.bytes !== Array)
                        object.data = $util.newBuffer(object.data);
                }
                if (options.bytes === String)
                    object.submitterPubkey = "";
                else {
                    object.submitterPubkey = [];
                    if (options.bytes !== Array)
                        object.submitterPubkey = $util.newBuffer(object.submitterPubkey);
                }
                if (options.bytes === String)
                    object.signature = "";
                else {
                    object.signature = [];
                    if (options.bytes !== Array)
                        object.signature = $util.newBuffer(object.signature);
                }
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.timestamp = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.timestamp = options.longs === String ? "0" : 0;
                object.confirmations = 0;
            }
            if (message.index != null && message.hasOwnProperty("index"))
                if (typeof message.index === "number")
                    object.index = options.longs === String ? String(message.index) : message.index;
                else
                    object.index = options.longs === String ? $util.Long.prototype.toString.call(message.index) : options.longs === Number ? new $util.LongBits(message.index.low >>> 0, message.index.high >>> 0).toNumber(true) : message.index;
            if (message.prevHash != null && message.hasOwnProperty("prevHash"))
                object.prevHash = options.bytes === String ? $util.base64.encode(message.prevHash, 0, message.prevHash.length) : options.bytes === Array ? Array.prototype.slice.call(message.prevHash) : message.prevHash;
            if (message.hash != null && message.hasOwnProperty("hash"))
                object.hash = options.bytes === String ? $util.base64.encode(message.hash, 0, message.hash.length) : options.bytes === Array ? Array.prototype.slice.call(message.hash) : message.hash;
            if (message.data != null && message.hasOwnProperty("data"))
                object.data = options.bytes === String ? $util.base64.encode(message.data, 0, message.data.length) : options.bytes === Array ? Array.prototype.slice.call(message.data) : message.data;
            if (message.submitterPubkey != null && message.hasOwnProperty("submitterPubkey"))
                object.submitterPubkey = options.bytes === String ? $util.base64.encode(message.submitterPubkey, 0, message.submitterPubkey.length) : options.bytes === Array ? Array.prototype.slice.call(message.submitterPubkey) : message.submitterPubkey;
            if (message.signature != null && message.hasOwnProperty("signature"))
                object.signature = options.bytes === String ? $util.base64.encode(message.signature, 0, message.signature.length) : options.bytes === Array ? Array.prototype.slice.call(message.signature) : message.signature;
            if (message.timestamp != null && message.hasOwnProperty("timestamp"))
                if (typeof message.timestamp === "number")
                    object.timestamp = options.longs === String ? String(message.timestamp) : message.timestamp;
                else
                    object.timestamp = options.longs === String ? $util.Long.prototype.toString.call(message.timestamp) : options.longs === Number ? new $util.LongBits(message.timestamp.low >>> 0, message.timestamp.high >>> 0).toNumber(true) : message.timestamp;
            if (message.confirmations != null && message.hasOwnProperty("confirmations"))
                object.confirmations = message.confirmations;
            if (message.confirmerPubkeys && message.confirmerPubkeys.length) {
                object.confirmerPubkeys = [];
                for (let j = 0; j < message.confirmerPubkeys.length; ++j)
                    object.confirmerPubkeys[j] = options.bytes === String ? $util.base64.encode(message.confirmerPubkeys[j], 0, message.confirmerPubkeys[j].length) : options.bytes === Array ? Array.prototype.slice.call(message.confirmerPubkeys[j]) : message.confirmerPubkeys[j];
            }
            return object;
        };

        /**
         * Converts this SharedLedgerEntry to JSON.
         * @function toJSON
         * @memberof magic.SharedLedgerEntry
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        SharedLedgerEntry.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for SharedLedgerEntry
         * @function getTypeUrl
         * @memberof magic.SharedLedgerEntry
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        SharedLedgerEntry.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/magic.SharedLedgerEntry";
        };

        return SharedLedgerEntry;
    })();

    magic.PeerInfo = (function() {

        /**
         * Properties of a PeerInfo.
         * @memberof magic
         * @interface IPeerInfo
         * @property {Uint8Array|null} [peerId] PeerInfo peerId
         * @property {Uint8Array|null} [pubkey] PeerInfo pubkey
         * @property {Array.<string>|null} [multiaddrs] PeerInfo multiaddrs
         * @property {Array.<string>|null} [offeredTags] PeerInfo offeredTags
         * @property {number|Long|null} [lastSeen] PeerInfo lastSeen
         */

        /**
         * Constructs a new PeerInfo.
         * @memberof magic
         * @classdesc Represents a PeerInfo.
         * @implements IPeerInfo
         * @constructor
         * @param {magic.IPeerInfo=} [properties] Properties to set
         */
        function PeerInfo(properties) {
            this.multiaddrs = [];
            this.offeredTags = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * PeerInfo peerId.
         * @member {Uint8Array} peerId
         * @memberof magic.PeerInfo
         * @instance
         */
        PeerInfo.prototype.peerId = $util.newBuffer([]);

        /**
         * PeerInfo pubkey.
         * @member {Uint8Array} pubkey
         * @memberof magic.PeerInfo
         * @instance
         */
        PeerInfo.prototype.pubkey = $util.newBuffer([]);

        /**
         * PeerInfo multiaddrs.
         * @member {Array.<string>} multiaddrs
         * @memberof magic.PeerInfo
         * @instance
         */
        PeerInfo.prototype.multiaddrs = $util.emptyArray;

        /**
         * PeerInfo offeredTags.
         * @member {Array.<string>} offeredTags
         * @memberof magic.PeerInfo
         * @instance
         */
        PeerInfo.prototype.offeredTags = $util.emptyArray;

        /**
         * PeerInfo lastSeen.
         * @member {number|Long} lastSeen
         * @memberof magic.PeerInfo
         * @instance
         */
        PeerInfo.prototype.lastSeen = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * Creates a new PeerInfo instance using the specified properties.
         * @function create
         * @memberof magic.PeerInfo
         * @static
         * @param {magic.IPeerInfo=} [properties] Properties to set
         * @returns {magic.PeerInfo} PeerInfo instance
         */
        PeerInfo.create = function create(properties) {
            return new PeerInfo(properties);
        };

        /**
         * Encodes the specified PeerInfo message. Does not implicitly {@link magic.PeerInfo.verify|verify} messages.
         * @function encode
         * @memberof magic.PeerInfo
         * @static
         * @param {magic.IPeerInfo} message PeerInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PeerInfo.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.peerId != null && Object.hasOwnProperty.call(message, "peerId"))
                writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.peerId);
            if (message.pubkey != null && Object.hasOwnProperty.call(message, "pubkey"))
                writer.uint32(/* id 2, wireType 2 =*/18).bytes(message.pubkey);
            if (message.multiaddrs != null && message.multiaddrs.length)
                for (let i = 0; i < message.multiaddrs.length; ++i)
                    writer.uint32(/* id 3, wireType 2 =*/26).string(message.multiaddrs[i]);
            if (message.offeredTags != null && message.offeredTags.length)
                for (let i = 0; i < message.offeredTags.length; ++i)
                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.offeredTags[i]);
            if (message.lastSeen != null && Object.hasOwnProperty.call(message, "lastSeen"))
                writer.uint32(/* id 5, wireType 0 =*/40).uint64(message.lastSeen);
            return writer;
        };

        /**
         * Encodes the specified PeerInfo message, length delimited. Does not implicitly {@link magic.PeerInfo.verify|verify} messages.
         * @function encodeDelimited
         * @memberof magic.PeerInfo
         * @static
         * @param {magic.IPeerInfo} message PeerInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PeerInfo.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a PeerInfo message from the specified reader or buffer.
         * @function decode
         * @memberof magic.PeerInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {magic.PeerInfo} PeerInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PeerInfo.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.magic.PeerInfo();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.peerId = reader.bytes();
                        break;
                    }
                case 2: {
                        message.pubkey = reader.bytes();
                        break;
                    }
                case 3: {
                        if (!(message.multiaddrs && message.multiaddrs.length))
                            message.multiaddrs = [];
                        message.multiaddrs.push(reader.string());
                        break;
                    }
                case 4: {
                        if (!(message.offeredTags && message.offeredTags.length))
                            message.offeredTags = [];
                        message.offeredTags.push(reader.string());
                        break;
                    }
                case 5: {
                        message.lastSeen = reader.uint64();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a PeerInfo message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof magic.PeerInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {magic.PeerInfo} PeerInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PeerInfo.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a PeerInfo message.
         * @function verify
         * @memberof magic.PeerInfo
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        PeerInfo.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.peerId != null && message.hasOwnProperty("peerId"))
                if (!(message.peerId && typeof message.peerId.length === "number" || $util.isString(message.peerId)))
                    return "peerId: buffer expected";
            if (message.pubkey != null && message.hasOwnProperty("pubkey"))
                if (!(message.pubkey && typeof message.pubkey.length === "number" || $util.isString(message.pubkey)))
                    return "pubkey: buffer expected";
            if (message.multiaddrs != null && message.hasOwnProperty("multiaddrs")) {
                if (!Array.isArray(message.multiaddrs))
                    return "multiaddrs: array expected";
                for (let i = 0; i < message.multiaddrs.length; ++i)
                    if (!$util.isString(message.multiaddrs[i]))
                        return "multiaddrs: string[] expected";
            }
            if (message.offeredTags != null && message.hasOwnProperty("offeredTags")) {
                if (!Array.isArray(message.offeredTags))
                    return "offeredTags: array expected";
                for (let i = 0; i < message.offeredTags.length; ++i)
                    if (!$util.isString(message.offeredTags[i]))
                        return "offeredTags: string[] expected";
            }
            if (message.lastSeen != null && message.hasOwnProperty("lastSeen"))
                if (!$util.isInteger(message.lastSeen) && !(message.lastSeen && $util.isInteger(message.lastSeen.low) && $util.isInteger(message.lastSeen.high)))
                    return "lastSeen: integer|Long expected";
            return null;
        };

        /**
         * Creates a PeerInfo message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof magic.PeerInfo
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {magic.PeerInfo} PeerInfo
         */
        PeerInfo.fromObject = function fromObject(object) {
            if (object instanceof $root.magic.PeerInfo)
                return object;
            let message = new $root.magic.PeerInfo();
            if (object.peerId != null)
                if (typeof object.peerId === "string")
                    $util.base64.decode(object.peerId, message.peerId = $util.newBuffer($util.base64.length(object.peerId)), 0);
                else if (object.peerId.length >= 0)
                    message.peerId = object.peerId;
            if (object.pubkey != null)
                if (typeof object.pubkey === "string")
                    $util.base64.decode(object.pubkey, message.pubkey = $util.newBuffer($util.base64.length(object.pubkey)), 0);
                else if (object.pubkey.length >= 0)
                    message.pubkey = object.pubkey;
            if (object.multiaddrs) {
                if (!Array.isArray(object.multiaddrs))
                    throw TypeError(".magic.PeerInfo.multiaddrs: array expected");
                message.multiaddrs = [];
                for (let i = 0; i < object.multiaddrs.length; ++i)
                    message.multiaddrs[i] = String(object.multiaddrs[i]);
            }
            if (object.offeredTags) {
                if (!Array.isArray(object.offeredTags))
                    throw TypeError(".magic.PeerInfo.offeredTags: array expected");
                message.offeredTags = [];
                for (let i = 0; i < object.offeredTags.length; ++i)
                    message.offeredTags[i] = String(object.offeredTags[i]);
            }
            if (object.lastSeen != null)
                if ($util.Long)
                    (message.lastSeen = $util.Long.fromValue(object.lastSeen)).unsigned = true;
                else if (typeof object.lastSeen === "string")
                    message.lastSeen = parseInt(object.lastSeen, 10);
                else if (typeof object.lastSeen === "number")
                    message.lastSeen = object.lastSeen;
                else if (typeof object.lastSeen === "object")
                    message.lastSeen = new $util.LongBits(object.lastSeen.low >>> 0, object.lastSeen.high >>> 0).toNumber(true);
            return message;
        };

        /**
         * Creates a plain object from a PeerInfo message. Also converts values to other types if specified.
         * @function toObject
         * @memberof magic.PeerInfo
         * @static
         * @param {magic.PeerInfo} message PeerInfo
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        PeerInfo.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults) {
                object.multiaddrs = [];
                object.offeredTags = [];
            }
            if (options.defaults) {
                if (options.bytes === String)
                    object.peerId = "";
                else {
                    object.peerId = [];
                    if (options.bytes !== Array)
                        object.peerId = $util.newBuffer(object.peerId);
                }
                if (options.bytes === String)
                    object.pubkey = "";
                else {
                    object.pubkey = [];
                    if (options.bytes !== Array)
                        object.pubkey = $util.newBuffer(object.pubkey);
                }
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.lastSeen = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.lastSeen = options.longs === String ? "0" : 0;
            }
            if (message.peerId != null && message.hasOwnProperty("peerId"))
                object.peerId = options.bytes === String ? $util.base64.encode(message.peerId, 0, message.peerId.length) : options.bytes === Array ? Array.prototype.slice.call(message.peerId) : message.peerId;
            if (message.pubkey != null && message.hasOwnProperty("pubkey"))
                object.pubkey = options.bytes === String ? $util.base64.encode(message.pubkey, 0, message.pubkey.length) : options.bytes === Array ? Array.prototype.slice.call(message.pubkey) : message.pubkey;
            if (message.multiaddrs && message.multiaddrs.length) {
                object.multiaddrs = [];
                for (let j = 0; j < message.multiaddrs.length; ++j)
                    object.multiaddrs[j] = message.multiaddrs[j];
            }
            if (message.offeredTags && message.offeredTags.length) {
                object.offeredTags = [];
                for (let j = 0; j < message.offeredTags.length; ++j)
                    object.offeredTags[j] = message.offeredTags[j];
            }
            if (message.lastSeen != null && message.hasOwnProperty("lastSeen"))
                if (typeof message.lastSeen === "number")
                    object.lastSeen = options.longs === String ? String(message.lastSeen) : message.lastSeen;
                else
                    object.lastSeen = options.longs === String ? $util.Long.prototype.toString.call(message.lastSeen) : options.longs === Number ? new $util.LongBits(message.lastSeen.low >>> 0, message.lastSeen.high >>> 0).toNumber(true) : message.lastSeen;
            return object;
        };

        /**
         * Converts this PeerInfo to JSON.
         * @function toJSON
         * @memberof magic.PeerInfo
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        PeerInfo.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for PeerInfo
         * @function getTypeUrl
         * @memberof magic.PeerInfo
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        PeerInfo.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/magic.PeerInfo";
        };

        return PeerInfo;
    })();

    magic.PeerExchange = (function() {

        /**
         * Properties of a PeerExchange.
         * @memberof magic
         * @interface IPeerExchange
         * @property {Array.<magic.IPeerInfo>|null} [peers] PeerExchange peers
         */

        /**
         * Constructs a new PeerExchange.
         * @memberof magic
         * @classdesc Represents a PeerExchange.
         * @implements IPeerExchange
         * @constructor
         * @param {magic.IPeerExchange=} [properties] Properties to set
         */
        function PeerExchange(properties) {
            this.peers = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * PeerExchange peers.
         * @member {Array.<magic.IPeerInfo>} peers
         * @memberof magic.PeerExchange
         * @instance
         */
        PeerExchange.prototype.peers = $util.emptyArray;

        /**
         * Creates a new PeerExchange instance using the specified properties.
         * @function create
         * @memberof magic.PeerExchange
         * @static
         * @param {magic.IPeerExchange=} [properties] Properties to set
         * @returns {magic.PeerExchange} PeerExchange instance
         */
        PeerExchange.create = function create(properties) {
            return new PeerExchange(properties);
        };

        /**
         * Encodes the specified PeerExchange message. Does not implicitly {@link magic.PeerExchange.verify|verify} messages.
         * @function encode
         * @memberof magic.PeerExchange
         * @static
         * @param {magic.IPeerExchange} message PeerExchange message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PeerExchange.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.peers != null && message.peers.length)
                for (let i = 0; i < message.peers.length; ++i)
                    $root.magic.PeerInfo.encode(message.peers[i], writer.uint32(/* id 1, wireType 2 =*/10).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified PeerExchange message, length delimited. Does not implicitly {@link magic.PeerExchange.verify|verify} messages.
         * @function encodeDelimited
         * @memberof magic.PeerExchange
         * @static
         * @param {magic.IPeerExchange} message PeerExchange message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PeerExchange.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a PeerExchange message from the specified reader or buffer.
         * @function decode
         * @memberof magic.PeerExchange
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {magic.PeerExchange} PeerExchange
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PeerExchange.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.magic.PeerExchange();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        if (!(message.peers && message.peers.length))
                            message.peers = [];
                        message.peers.push($root.magic.PeerInfo.decode(reader, reader.uint32()));
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a PeerExchange message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof magic.PeerExchange
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {magic.PeerExchange} PeerExchange
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PeerExchange.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a PeerExchange message.
         * @function verify
         * @memberof magic.PeerExchange
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        PeerExchange.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.peers != null && message.hasOwnProperty("peers")) {
                if (!Array.isArray(message.peers))
                    return "peers: array expected";
                for (let i = 0; i < message.peers.length; ++i) {
                    let error = $root.magic.PeerInfo.verify(message.peers[i]);
                    if (error)
                        return "peers." + error;
                }
            }
            return null;
        };

        /**
         * Creates a PeerExchange message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof magic.PeerExchange
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {magic.PeerExchange} PeerExchange
         */
        PeerExchange.fromObject = function fromObject(object) {
            if (object instanceof $root.magic.PeerExchange)
                return object;
            let message = new $root.magic.PeerExchange();
            if (object.peers) {
                if (!Array.isArray(object.peers))
                    throw TypeError(".magic.PeerExchange.peers: array expected");
                message.peers = [];
                for (let i = 0; i < object.peers.length; ++i) {
                    if (typeof object.peers[i] !== "object")
                        throw TypeError(".magic.PeerExchange.peers: object expected");
                    message.peers[i] = $root.magic.PeerInfo.fromObject(object.peers[i]);
                }
            }
            return message;
        };

        /**
         * Creates a plain object from a PeerExchange message. Also converts values to other types if specified.
         * @function toObject
         * @memberof magic.PeerExchange
         * @static
         * @param {magic.PeerExchange} message PeerExchange
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        PeerExchange.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.peers = [];
            if (message.peers && message.peers.length) {
                object.peers = [];
                for (let j = 0; j < message.peers.length; ++j)
                    object.peers[j] = $root.magic.PeerInfo.toObject(message.peers[j], options);
            }
            return object;
        };

        /**
         * Converts this PeerExchange to JSON.
         * @function toJSON
         * @memberof magic.PeerExchange
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        PeerExchange.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for PeerExchange
         * @function getTypeUrl
         * @memberof magic.PeerExchange
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        PeerExchange.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/magic.PeerExchange";
        };

        return PeerExchange;
    })();

    return magic;
})();

export { $root as default };
