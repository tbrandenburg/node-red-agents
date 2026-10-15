"use strict";

// v2's projected timeline is newest first. The first idle after the admitted
// user bounds this execution; later turns and older idle markers do not belong.
function completedTurn(messages, admissionID) {
  const anchor = messages.findIndex((entry) => entry?.id === admissionID && entry.type === "user");
  if (anchor < 0) return;
  const timeline = messages.slice(0, anchor).reverse();
  const terminal = timeline.findIndex((entry) => entry?.type === "idle");
  if (terminal < 0) return;
  return {
    idle: timeline[terminal],
    assistant: timeline.slice(0, terminal).findLast((entry) => entry?.type === "assistant"),
  };
}

module.exports = { completedTurn };
