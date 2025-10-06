// lib/bridgeNotify.js
async function notifyCompletedInChannel(client, channelId, payload) {
    // payload: { userId, orderId, total, secret }
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.send) throw new Error("Bridge channel not found or not sendable.");
    await channel.send("!completed " + JSON.stringify(payload));
  }
  
  module.exports = { notifyCompletedInChannel };
  