module.exports = function (RED) {
    function ExampleNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', function (msg, send, done) {
            msg.payload = String(msg.payload).toUpperCase();
            send(msg);
            if (done) done();
        });
    }
    RED.nodes.registerType('example-node', ExampleNode);
};
