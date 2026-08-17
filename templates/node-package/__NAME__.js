module.exports = function (RED) {
  function CustomNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.on("input", function (msg, send, done) {
      // TODO: implement __NAME__
      send(msg);
      if (done) done();
    });
  }
  RED.nodes.registerType("__NAME__", CustomNode);
};
