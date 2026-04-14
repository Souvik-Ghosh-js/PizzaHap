/**
 * Socket.IO singleton — set once from server.js, used everywhere.
 */
let _io = null;

const setIO = (io) => { _io = io; };
const getIO = () => _io;

module.exports = { setIO, getIO };
