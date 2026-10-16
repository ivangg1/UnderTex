import { describe, it, expect, vi, type Mock } from "vitest";

// In-memory test of the y-webrtc signaling message dispatch logic
describe("y-webrtc Signaling Protocol Dispatcher", () => {
  interface MockConn {
    id: string;
    readyState: number;
    send: Mock<(data: string) => void>;
    close: Mock<() => void>;
  }

  function createMockConn(id: string): MockConn {
    return {
      id,
      readyState: 1, // OPEN
      send: vi.fn(),
      close: vi.fn(),
    };
  }

  function createSignalingDispatcher() {
    const topics = new Map<string, Set<MockConn>>();

    const send = (conn: MockConn, message: object) => {
      if (conn.readyState === 1) {
        conn.send(JSON.stringify(message));
      }
    };

    const handleMessage = (
      conn: MockConn,
      subscribedTopics: Set<string>,
      message: any
    ) => {
      if (!message || !message.type) return;

      switch (message.type) {
        case "subscribe":
          (message.topics || []).forEach((topicName: string) => {
            if (typeof topicName === "string") {
              if (!topics.has(topicName)) {
                topics.set(topicName, new Set());
              }
              topics.get(topicName)!.add(conn);
              subscribedTopics.add(topicName);
            }
          });
          break;

        case "unsubscribe":
          (message.topics || []).forEach((topicName: string) => {
            const subs = topics.get(topicName);
            if (subs) {
              subs.delete(conn);
              if (subs.size === 0) {
                topics.delete(topicName);
              }
            }
          });
          break;

        case "publish":
          if (message.topic) {
            const receivers = topics.get(message.topic);
            if (receivers) {
              message.clients = receivers.size;
              receivers.forEach((receiver) => {
                send(receiver, message);
              });
            }
          }
          break;

        case "ping":
          send(conn, { type: "pong" });
          break;
      }
    };

    const handleDisconnect = (
      conn: MockConn,
      subscribedTopics: Set<string>
    ) => {
      subscribedTopics.forEach((topicName) => {
        const subs = topics.get(topicName);
        if (subs) {
          subs.delete(conn);
          if (subs.size === 0) {
            topics.delete(topicName);
          }
        }
      });
      subscribedTopics.clear();
    };

    return { topics, handleMessage, handleDisconnect };
  }

  it("responds to ping with pong", () => {
    const { handleMessage } = createSignalingDispatcher();
    const conn = createMockConn("peer1");
    const subs = new Set<string>();

    handleMessage(conn, subs, { type: "ping" });

    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(conn.send.mock.calls[0][0])).toEqual({ type: "pong" });
  });

  it("subscribes peers and routes publish messages to topic subscribers", () => {
    const { topics, handleMessage } = createSignalingDispatcher();
    const connA = createMockConn("peerA");
    const connB = createMockConn("peerB");
    const subsA = new Set<string>();
    const subsB = new Set<string>();

    // Both peers subscribe to room-abc
    handleMessage(connA, subsA, { type: "subscribe", topics: ["room-abc"] });
    handleMessage(connB, subsB, { type: "subscribe", topics: ["room-abc"] });

    expect(topics.get("room-abc")?.size).toBe(2);

    // Peer A publishes WebRTC offer to room-abc
    const payload = {
      type: "publish",
      topic: "room-abc",
      data: "webrtc-offer-sdp",
    };
    handleMessage(connA, subsA, payload);

    // Both subscribers receive the published message with updated clients count
    expect(connA.send).toHaveBeenCalledTimes(1);
    expect(connB.send).toHaveBeenCalledTimes(1);

    const receivedB = JSON.parse(connB.send.mock.calls[0][0]);
    expect(receivedB.data).toBe("webrtc-offer-sdp");
    expect(receivedB.clients).toBe(2);
  });

  it("cleans up subscriptions on peer disconnect", () => {
    const { topics, handleMessage, handleDisconnect } =
      createSignalingDispatcher();
    const conn = createMockConn("peer-temp");
    const subs = new Set<string>();

    handleMessage(conn, subs, { type: "subscribe", topics: ["room-temp"] });
    expect(topics.get("room-temp")?.size).toBe(1);

    handleDisconnect(conn, subs);
    expect(topics.has("room-temp")).toBe(false);
  });
});
