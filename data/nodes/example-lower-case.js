module.exports = function (RED) {
    function LowerCaseNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', function (msg, send, done) {
            msg.payload = String(msg.payload).toLowerCase();
            send(msg);
            if (done) done();
        });
    }
    RED.nodes.registerType('example-lower-case', LowerCaseNode);
};
