"use strict";

var utils      = require(__dirname + '/lib/utils'); // Get common adapter utils
var MySensors  = require(__dirname + '/lib/mysensors');
var sensorEnums = require(__dirname + '/lib/mysensors-enums');
var meta = require(__dirname + '/lib/getmeta').meta;

var STATE_INCLUSION_ON = 'commands.inclusionOn',
    STATE_INFO_CONNECTION = 'info.connection'
    //STATE_REQUEST_PRESENTATION = 'common.requestPresentation',
    //STATE_REQUEST_HEARTBEAT = 'common.requestHeartbeat',
    //STATE_REQUEST_REBOOT = 'common.requestReboot',
    //STATE_RAW_COMMAND = 'common.rawCommand'
    ;

var devices   = {};
var mySensorsInterface;
var inclusionOn = true;
var inclusionTimeoutTimer = null;
//var presentationDone = false;
var gatewayReady = false;
var config = {};


var serialport;

try {
    serialport = require('serialport');
} catch (e) {
    console.warn('Serial port is not available');
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

var adapter = utils.adapter({
    name: 'mysensors',

    unload: function (callback) {
        adapter.setState(STATE_INFO_CONNECTION, false, true);
        try {
            if (mySensorsInterface) mySensorsInterface.destroy();
            mySensorsInterface = null;
            callback();
        } catch (e) {
            callback();
        }
    },

    objectChange: function (id, obj) {
        if (!obj) {
            if (devices[id]) delete devices[id];
        } else {
            if (obj.native.id !== undefined && obj.native.childId !== undefined && obj.native.subType !== undefined) {
                devices[id] = obj;
            }
        }
    },

    stateChange: function (id, state) {
        if (!state || state.ack || !mySensorsInterface)
            return;
        onStateChange(id, state);
    },

    ready: function () {
        main();
    },

    message: function(obj) {
        if (!obj) return;
        switch (obj.command) {
            case 'listUart':
                if (obj.callback) {
                    if (serialport) {
                        // read all found serial ports
                        serialport.list(function (err, ports) {
                            adapter.log.info('List of port: ' + JSON.stringify(ports));
                            adapter.sendTo(obj.from, obj.command, ports, obj.callback);
                        });
                    } else {
                        adapter.log.warn('Module serialport is not available');
                        adapter.sendTo(obj.from, obj.command, [{comName: 'Not available'}], obj.callback);
                    }
                }
                break;
        }
    },

    discover: function (callback) {
    },

    uninstall: function (callback) {
    }
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function onStateChange(id, state) {
    adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

    var commandIdx = id.indexOf('.commands.');
    if (commandIdx > 0) {
        var cmd = id.substr(commandIdx+10);
        if (commands[cmd] != undefined) {
            if (commandIdx == adapter.namespace.length) {
                commands[cmd] (state.val);
            } else {
                commands[cmd] (id);
            }
            //if (cmd.indexOf('request') == 0) {
            //    adapter.setState(id, false, true);
            //}
            return;
        }
    }

    if (devices[id] && devices[id].type == 'state') {
        if (typeof state.val === 'boolean') state.val = state.val ? 1 : 0;
        if (state.val === 'true')  state.val = 1;
        if (state.val === 'false') state.val = 0;

        mySensorsInterface.write(
            devices[id].native.id           + ';' +
            devices[id].native.childId      + ';' + C_SET + ';' + ACK_FALSE + ';' +
            devices[id].native.varTypeNum   + ';' +
            state.val, devices[id].native.ip);
    }
}

function mysSend(destination, sensor, command, acknowledge, type, payload, ip) {
    if (typeof destination == 'string' && destination.indexOf ('.') >= 0) {
        if (destination.indexOf(adapter.namespace) != 0) {
            destination = adapter.namespace + '.' + destination;
        }
        var dev = devices[destination];
        if (!dev) return;
        destination = dev.native.id;
        if (!ip) ip = dev.native.ip;
    }
    if (destination == undefined) return;
    mySensorsInterface.write(
        (typeof destination == 'string' ? destination : destination.toString()) + ';' +
        sensor.toString() + ';' +
        command.toString() + ';' +
        acknowledge.toString() + ';' +
        type.toString() + ';' +
        payload,
        ip);
}


var commands = {
    requestPresentation: function (id, ip) {
        //'255;0;3;0;19;0'
        mysSend(id, 0, C_INTERNAL, ACK_NO, I_PRESENTATION, '0', ip);
    },
    requestReboot: function (id, ip) {
        //'255;0;3;0;13;0'
        mysSend(id, 0, C_INTERNAL, ACK_NO, I_REBOOT, '0', ip);
    },
    requestHeartbeat: function (id, ip) {
        //'255;0;3;0;18;'
        mysSend(id, 0, C_INTERNAL, ACK_NO, I_HEARTBEAT, '0', ip);
    },
    rawCommand: function(cmd, ip) {
        mySensorsInterface.write(cmd, ip);
    },
    inclusionOn: function(bo) {
        setInclusionState(bo);
    }
};


function setInclusionState(val) {
    val = val === 'true' || val === true || val === 1 || val === '1';
    inclusionOn = val;

    if (inclusionTimeoutTimer) clearTimeout(inclusionTimeoutTimer);
    inclusionTimeoutTimer = null;

    if (inclusionOn && parseInt(adapter.config.inclusionTimeout)) {
        inclusionTimeoutTimer = setTimeout(function () {
            inclusionOn = false;
            adapter.setState(STATE_INCLUSION_ON, false, true);
        }, parseInt(adapter.config.inclusionTimeout));
    }
}

function checkInclusion(result, msg) {
    if (!inclusionOn) {
        adapter.log.warn(msg ? msg : 'ID not found. Inclusion mode OFF: ' + JSON.stringify(result));
    }
    return inclusionOn;
}


function fullIdFromPacket(ip, packet) {
    return adapter.namespace + '.' + meta.deviceIdFromPacket(ip, packet);
}


function findDevice(result, ip) {
    // test
    var _id = fullIdFromPacket(ip, result);
    var rt = devices[_id];
    //if (rt) return _id; else return undefined;
    return (rt ? _id : undefined);
    //
    for (var id in devices) {
        if (devices[id].native &&
            (!ip || ip == devices[id].native.ip) &&
            devices[id].native.id == result.id &&
            devices[id].native.childId == result.childId &&
            devices[id].native.varType == result.subType) {
            if (_id != id) {
                id = id;
            }
            return id;
        }
    }
    if (rt != undefined) {
        rt = rt;
    }
    return undefined;
}


function createStateFromPacket(ip, res, cb, id) {
    if (!id) {
        id = fullIdFromPacket(ip, res);
    }
    var obj = {
        _id: id,
        type: 'state',
        common: {
            name: '',
            role: 'state'
        },
        native: {
            ip: ip,
            id: res.id,
            childId: res.childId,
            subType: res.subType,
            varType: res.subType, //why varType and not subType?
            type: res.type,
            subTypeNum: res.num.subType,
            typeNum: res.num.type
        }
    };
    var parentId = id.substr(0, id.lastIndexOf('.'));
    obj.common.name = (devices[parentId] && devices[parentId].common.name) ? devices[parentId].common.name + '.' + res.subType : res.subType;
    devices[id] = obj;
    adapter.log.info('Add new object: ' + id);
    adapter.setObject(id, obj, function (err) {
        if (err) adapter.log.error(err);
        if (cb) cb(id); else adapter.setState(id, '', true);
    });
}


function saveResult(_id, result, ip, force) {
    if (_id == undefined) _id = findDevice(result, ip);

    function doIt(id) {
        if (devices[id].common.type == 'boolean') {
            result.payload = result.payload === 'true' || result.payload === true || result.payload === '1' || result.payload === 1;
        }
        if (devices[id].common.type == 'number')  result.payload = parseFloat(result.payload);

        adapter.log.debug('Set value ' + (devices[id].common.name || id) + ' ' + result.childId + ': ' + result.payload + ' ' + typeof result.payload);
        adapter.setState(id, result.payload, true);
        adapter.getObject(id, function(err, obj) {
            if (!err && obj) {
                var now = new Date();
                obj['lastChange'] = adapter.formatDate(new Date(), "YYYY-MM-DD - hh:mm:ss");
                adapter.setObject(id, obj);
            }
        })
    }

    if (_id != undefined && devices[_id]) {
        doIt(_id);
        return;
    }
    if (force) createStateFromPacket(ip, result, doIt);
}


function createDefaultCommands(id, sensorId, ip) {
    var i = 0;
    var cmds = [];
    for (var cmd in commands) {
        if (cmd.indexOf('request') == 0)
            cmds.push(cmd);
    }
    function doIt() {
        if (i < cmds.length) {
            var _id = id + '.commands.' + cmds[i];
            if (devices[_id]) {
                i++;
                setTimeout(doIt, 20);
                return;
            }
            var obj = {
                "_id": _id,
                "type": "state",
                "common": {
                    "role": "state",
                    "name": cmds[i],
                    "desc": cmds[i],
                    "type": "boolean",
                    "read": true,
                    "write": true,
                    "def": false
                },
                "native": {
                    id: sensorId,
                    ip: ip
                }
            };
            devices[_id] = obj;
            adapter.setObject(_id, obj, function (err, o) {
                adapter.setState(_id, false, true);
                i++;
                setTimeout(doIt, 20);
            });
        }
    }
    doIt();
}

// ToDo
var pendingCommands = { // for battery powered or sleeping devices
    cnt: 0,
    arr: [],

    add: function(cmd) {
        this.arr.push(cmd);
        this.cnt++;
    },

    check: function(id, ip) {
        if (this.cnt <= 0) return;
        if (id != 2) return;

        while (this.arr.length) {
            var cmd = this.arr.shift();
            adapter.log.info('Sending pending command: ' + cmd);
            mySensorsInterface.write(cmd);
            this.cnt--
        }

        return;

        if (!id || !devices[id].native.id) return;
        var _id = fullIdFromPacket(ip, {id: devices[id].native.id});
        var pendingCmds = devices[id].pending;
        while (pendingCmds.length) {
            var cmd = pendingCmds.slice();
            mySensorsInterface.write(cmd);
            this.cnt--
        }
    }
};

//pendingCommands.add('2;0;3;0;19;0');


function createNode(res, ip, port) {
    var objs = meta.getMetaInfo(res, ip, port, config[ip || 'serial']);

    function doIt() {
        if (objs.length > 0) {
            var obj = objs.shift();
            var fullId = adapter.namespace + '.' + obj._id
            //adapter.log.debug('Check ' + devices[fullId]);
            if (!devices[fullId]) {
                devices[fullId] = obj;
                adapter.log.info('Add new object: ' + obj._id + ' - ' + obj.common.name);
                adapter.setObject(obj._id, obj, function (err) {
                    if (err) {
                        adapter.log.error(err);
                    } else {
                        if (obj.common && obj.common.def != undefined) {
                            adapter.setState(fullId, obj.common.def, true);
                        }
                    }
                    setTimeout(doIt, 20);
                });
            }
        }
    }
    doIt();
}


function onData (data, ip, port) {
    var result = sensorEnums.parse(data, true);
    if (!result) {
        adapter.log.warn('Cannot parse data: ' + data);
        return;
    }
    for (var i = 0; i < result.length; i++) {
       onDataPacket(result[i], ip, port)
    }
}

function onDataPacket (res, ip, port) {
    adapter.log.info('Got from ' + (ip?ip:'') + ': ' + ('  '+res.id).slice(-3) + '; ' + ('  '+res.childId).slice(-3) + '; ' + ((res.type+';            ').substr(0, 18)) + (res.ack ? 'ACK_TRUE ' : 'ACK_FALSE') + '; ' + ((res.subType+';                     ').substr(0,27)) + res.payload);

    //var __id = fullIdFromPacket(ip, res);
    var id = findDevice(res, ip);
    if (pendingCommands.cnt) pendingCommands.check(res.num.id, ip);

    switch (res.num.type) {

        ////////////////////////////////////////////////////////////////////////////////////////////////////////////
        case C_PRESENTATION:
            //presentationDone = true;
            if (id || !checkInclusion(res) || !res.subType)
                break;
            adapter.log.debug('ID not found. Try to add to to DB');
            createNode(res, ip, port);
            break;

        ////////////////////////////////////////////////////////////////////////////////////////////////////////////
        case C_REQ:
            if (!id) {
                id = fullIdFromPacket(ip, res);
                if (checkInclusion(res)) {
                    if (!devices[id]) {
                        adapter.log.debug('ID not found. Try to add to to DB');
                        createStateFromPacket(ip, res, undefined, id);
                    }
                }
            }

            switch (res.subType) {

                default:
                    adapter.getState(id, function (err, state) {
                        if (!state || err) state = {val: ""};
                        mySensorsInterface.write(res.id + ';' + res.childId + ';1;0;' + res.num.subType + ';' + state.val, ip);
                    });
                    break;
            }
            break;

        ////////////////////////////////////////////////////////////////////////////////////////////////////////////
        case C_SET:
            // If set quality
            if (res.subType == 77) {
                adapter.log.debug('subType = 77');
                for (var id in devices) {
                    if (devices[id].native &&
                        (!ip || ip == devices[id].native.ip) &&
                        devices[id].native.id == res.id &&
                        devices[id].native.childId == res.childId) {
                        adapter.log.debug('Set quality of ' + (devices[id].common.name || id) + ' ' + res.childId + ': ' + res.payload + ' ' + typeof res.payload);
                        adapter.setState(id, {q: typeof res.payload}, true);
                    }
                }
            } else {
                if (res.subType === 'V_LIGHT')  res.subType = 'V_STATUS';
                if (res.subType === 'V_DIMMER') res.subType = 'V_PERCENTAGE';
                if (res.subType === 'V_DUST_LEVEL') res.subType = 'V_LEVEL';

                if(res.ack) {
                    adapter.log.debug('ack needed');
                }

                saveResult(id, res, ip);
            }
            break;

        ////////////////////////////////////////////////////////////////////////////////////////////////////////////
        case C_INTERNAL:
            var saveValue = false;
            //var _id = fullIdFromPacket(ip, res);
            switch (res.num.subType) {
                case I_BATTERY_VOLTAGE:
                case I_BATTERY_LEVEL:
                    //adapter.log.debug('Battery level ' + (ip ? ' from ' + ip + ' ' : '') + ':' + res.payload);
                    saveValue = true;
                    break;

                case I_TIME:              //   1   Sensors can request the current time from the Controller using this message. The time will be reported as the seconds since 1970
                    adapter.log.debug('Time ' + (ip ? ' from ' + ip + ' ' : '') + ':' + res.payload);
                    if (!res.ack) {
                        mysSend(res.id, res.childId, C_INTERNAL, ACK_TRUE, res.subType, Math.round(new Date().getTime() / 1000), ip);
                    }
                    break;

                case I_SKETCH_VERSION:
                case I_VERSION:           //   2   Used to request gateway version from controller.
                    adapter.log.debug(res.subType + (ip ? ' from ' + ip + '' : '') + ': ' + res.payload);
                    saveValue = true;
                    if (!res.ack && res.num.subType === I_VERSION) {
                        mysSend(res.id, res.childId, C_INTERNAL, ACK_TRUE, res.subType, (adapter.version || 0), ip);
                    }
                    break;

                case I_SKETCH_NAME:
                    adapter.log.debug(res.subType + (ip ? ' from ' + ip + '' : '') + ': ' + res.payload);
                    saveValue = true;
                    if (!checkInclusion(res)) {
                        break;
                    }
                    var name = res.payload;
                    var _id = meta._getId(ip, res);
                    adapter.getObject(_id, function (err, obj) {
                        if (!obj) {
                            obj = {type: 'device', common: {name: name}, native: { id: res.id, ip: ip}}
                        } else if (obj.common.name === name) {
                            return;
                        }
                        obj.common.name = name;
                        adapter.setObject(adapter.namespace + '.' + _id, obj, function (err) {
                            createDefaultCommands(adapter.namespace + '.' + _id, res.id, ip);
                        });
                    });
                    break;

                case I_INCLUSION_MODE:
                    adapter.log.info('inclusion mode ' + (ip ? ' from ' + ip + ' ' : '') + ':' + res.payload ? 'STARTED' : 'STOPPED');
                    break;

                case I_CONFIG:
                    res.payload = (res.payload == 'I') ? 'Imperial' : 'Metric';
                    adapter.log.info(res.subType + (ip ? ' from ' + ip : '') + ': ' + res.payload);
                    config[ip || 'serial'] = config[ip || 'serial'] || {};
                    config[ip || 'serial'].metric = res.payload;
                    //mysSend(NODE_SENSOR_ID/*res.id*/, res.childId, C_INTERNAL, ACK_FALSE, I_CONFIG, 'M', ip);
                    saveValue = true;
                    break;

                case I_LOG_MESSAGE:
                    adapter.log.info('Log ' + (ip ? ' from ' + ip + ' ' : '') + ':' + res.payload);
                    break;

                case I_ID_REQUEST:
                    if (checkInclusion(res, 'Received I_ID_REQUEST, but inclusion mode is disabled')) {
                        // find maximal index
                        var maxId = 0;
                        for (var id in devices) {
                            if (devices[id].native && (!ip || ip == devices[id].native.ip) &&
                                devices[id].native.id > maxId) {
                                maxId = devices[id].native.id;
                            }
                        }
                        maxId++;
                        if (!res.ack) {
                            mysSend(res.id, res.childId, C_INTERNAL, ACK_FALSE, I_ID_RESPONSE, maxId, ip);
                        }
                    }
                    break;
                case I_GATEWAY_READY:
                    gatewayReady = true;
                    break;
                case I_HEARTBEAT_RESPONSE:
                    break;

                default:
                    adapter.log.warn('Received unprocessed INTERNAL message: ' + res.subType + ': ' + res.payload);

            }

            if (saveValue) {
                saveResult(id, res, ip, true);
            }
            break;

        ////////////////////////////////////////////////////////////////////////////////////////////////////////////
        case C_STREAM:
            switch (res.num.subType) {
                case ST_FIRMWARE_CONFIG_REQUEST:
                    //pushWord(payload, result.type);
                    //pushWord(payload, result.version);
                    //pushWord(payload, result.blocks);
                    //pushWord(payload, result.crc);
                    //var sensor = NODE_SENSOR_ID;
                    //var command = C_STREAM;
                    //var acknowledge = 0; // no ack
                    //var type = ST_FIRMWARE_CONFIG_RESPONSE;
                    //mySensorsInterface.write(res.id + ';' + res.childId + ';' + C_STREAM + ';0;' + ST_FIRMWARE_CONFIG_RESPONSE + ';' + '0000' + '0000' + '0000' + '0000', ip);

                    break;
                case ST_FIRMWARE_CONFIG_RESPONSE:
                    break;
                case ST_FIRMWARE_REQUEST:
                    break;
                case ST_FIRMWARE_RESPONSE:
                    break;
                case ST_SOUND:
                    break;
                case ST_IMAGE:
                    break;
            }
            break;
    }
}


function checkInstanceObjects(force, cb) {
    var i = 0;
    function doIt() {
        if (i < adapter.ioPack.instanceObjects.length) {
            var obj = adapter.ioPack.instanceObjects[i++];
            var id = adapter.namespace + '.' + obj._id;
            adapter.getObject(id, function(err, o) {
               if (force || err || !o) {
                   adapter.setObject(id, obj, function(err, o) {
                       if(!err && obj && obj.common && obj.common.def != undefined) {
                           adapter.setState(id, obj.common.def, true);
                       }
                       setTimeout(doIt, 20);
                   });
               } else setTimeout(doIt, 20);
            });
        } else {
            if (cb) cb();
        }
    }
    doIt();
}


function readExistingObjects (cb) {

    adapter.getForeignObjects(adapter.namespace + '.*', 'state', function (err, states) {
        devices = states;

        adapter.getForeignObjects(adapter.namespace + '.*', 'channel', function (err, states) {
            for (var o in states) {
                devices [o] = states[o];
            }

            if (!devices[adapter.namespace + '.'+STATE_INFO_CONNECTION] || !devices[adapter.namespace + '.'+STATE_INFO_CONNECTION].common ||
                (devices[adapter.namespace + '.'+STATE_INFO_CONNECTION].common.type === 'boolean' && adapter.config.type !== 'serial') ||
                (devices[adapter.namespace + '.'+STATE_INFO_CONNECTION].common.type !== 'boolean' && adapter.config.type === 'serial')) {
                adapter.setForeignObject(adapter.namespace + '.info.connection', {
                    _id: STATE_INFO_CONNECTION,
                    type: 'state',
                    common: {
                        role: 'indicator.connected',
                        name: adapter.config.type === 'serial' ? 'If connected to my sensors' : 'List of connected gateways',
                        type: adapter.config.type === 'serial' ? 'boolean' : 'string',
                        read: true,
                        write: false,
                        def: false
                    },
                    native: {}
                }, function (err) {
                    if (err) adapter.log.error(err);
                });
            }
            if(cb) cb();
        })
    })
}


function run() {
    mySensorsInterface = new MySensors(adapter.config, adapter.log, function (error) {
        mySensorsInterface.write('0;0;3;0;14;Gateway startup complete');
        mySensorsInterface.on('data', onData);

        mySensorsInterface.on('connectionChange', function (isConn, ip, port) {
            adapter.setState(STATE_INFO_CONNECTION, isConn, true);
            // try soft request
            //if (!presentationDone && isConn) {
            if (!gatewayReady && isConn) {
                //mySensorsInterface.write('0;0;3;0;6;get metric', ip, port);
                mySensorsInterface.write('0;0;' + C_INTERNAL + ';' + ACK_FALSE + ';' + I_CONFIG + ';get metric', ip);
                //mySensorsInterface.write('0;0;3;0;19;force presentation', ip, port);
                commands.requestPresentation(0, ip);
                setTimeout(function () {
                    // send reboot command if still no presentation
                    //if (!presentationDone) {
                    if (!gatewayReady) {
                        //mySensorsInterface.write('0;0;3;0;13;force restart', ip, port);
                        commands.requestReboot(0, ip);
                    }
                }, 1500);
            }
        });
    });
}


//function main() {
//    checkInstanceObjects(false, function() {
//        adapter.getState(STATE_INCLUSION_ON, function (err, state) {
//            if (state == null) {
//                checkInstanceObjects(true);
//            }
//            setInclusionState(state ? state.val : true);
//        });
//    });
//
//    readExistingObjects(function () {
//        adapter.subscribeStates('*');
//        adapter.subscribeObjects('*');
//
//        run();
//    });
//}

function main() {
    checkInstanceObjects(false, function() {
        adapter.getState(STATE_INCLUSION_ON, function (err, state) {
            if (state == null) {
                checkInstanceObjects(true);
            }
            setInclusionState(state ? state.val : true);

            readExistingObjects(function () {
                adapter.subscribeStates('*');
                adapter.subscribeObjects('*');

                run();
            });
        });
    });
}
