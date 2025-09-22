import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WS from "jest-websocket-mock";
import FileSystem, { FileSystemError } from "./index.js";
import { FileEvent, FileSystemState } from "./types.js";
import runInParallel from "@test-utils/runInParallel.js";

describe("FileSystem", () => {
  let server: WS;
  let fs: FileSystem;
  const WS_URL = "ws://localhost:8080";

  beforeEach(async () => {
    server = new WS(WS_URL, { jsonProtocol: true });
    fs = new FileSystem(WS_URL);
  });

  afterEach(() => {
    fs.disconnect();
    WS.clean();
  });

  describe("connection management", () => {
    it("should start in DISCONNECTED state", () => {
      expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);
    });

    it("should transition to CONNECTING then CONNECTED", async () => {
      const states: FileSystemState[] = [];
      const removeListener = fs.addStateListener((state) => {
        states.push(state);
      });

      await runInParallel(
        async () => {
          // Trigger connection by calling commit
          await fs.commit("some changes");
        },
        async () => {
          // Accept the connection
          await server.connected;

          // Send response
          server.send({
            type: "committed",
          });
        },
      );

      expect(states).toContain(FileSystemState.DISCONNECTED);
      expect(states).toContain(FileSystemState.CONNECTING);
      expect(states).toContain(FileSystemState.CONNECTED);

      removeListener();
    });

    it("should handle connection errors", async () => {
      server.error();

      await expect(fs.commit("some changes")).rejects.toThrow(FileSystemError);

      expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);
    });

    it("should handle connection close", async () => {
      await runInParallel(
        async () => {
          await expect(fs.commit("Some changes")).rejects.toThrow(
            "Connection closed",
          );
          expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);
        },
        async () => {
          await server.connected;

          // Close connection before sending response
          server.close();
        },
      );
    });
  });

  describe("FIFO command handling", () => {
    it("should handle multiple commands in order", async () => {
      await runInParallel(
        async () => {
          const file1 = fs.openFile("file1.txt");
          const firstEvent = await file1.getEvents().next();
          expect(firstEvent.value).toEqual({
            type: "file_opened",
            handle: "1",
            content: "content1",
          });

          // Start multiple commands - they will queue up
          const writeFilePromise = file1.writeFile("content1", "new1");
          const commitPromise = fs.commit("some changes");

          await expect(writeFilePromise).resolves.toBe("new1");
          await expect(commitPromise).resolves.toBeUndefined();
        },
        async () => {
          await server.connected;

          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "file1.txt",
          });

          server.send({
            type: "file_opened",
            handle: "1",
            content: "content1",
          });

          await expect(server).toReceiveMessage({
            type: "write_file",
            handle: "1",
            last_content: "content1",
            new_content: "new1",
          });

          await expect(server).toReceiveMessage({
            type: "commit",
            message: "some changes",
          });

          server.send({
            type: "file_written",
            handle: "1",
            content: "new1",
          });

          server.send({
            type: "committed",
          });
        },
      );
    });

    it("should ignore file_updated events in FIFO", async () => {
      await runInParallel(
        async () => {
          const file = fs.openFile("other.txt");
          await fs.commit("some changes");
        },
        async () => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "other.txt",
            handle: "1",
          });
          server.send({
            type: "file_opened",
            handle: "1",
            content: "initial content",
          });

          await expect(server).toReceiveMessage({
            type: "commit",
            message: "some changes",
          });

          // Send file_updated (should be ignored)
          server.send({
            type: "file_updated",
            handle: "1",
            content: "updated content",
          });

          // Send actual response
          server.send({
            type: "committed",
          });
        },
      );
    });
  });

  describe("state listeners", () => {
    it("should call listener immediately with current state", () => {
      const states: FileSystemState[] = [];
      fs.addStateListener((state) => states.push(state));

      expect(states).toEqual([FileSystemState.DISCONNECTED]);
    });

    it("should remove listener when returned function is called", async () => {
      await runInParallel(
        async () => {
          const states1: FileSystemState[] = [];
          const states2: FileSystemState[] = [];

          // Add two listeners
          const removeListener1 = fs.addStateListener((state) =>
            states1.push(state),
          );
          const removeListener2 = fs.addStateListener((state) =>
            states2.push(state),
          );

          // Both should get initial state
          expect(states1).toEqual([FileSystemState.DISCONNECTED]);
          expect(states2).toEqual([FileSystemState.DISCONNECTED]);

          // Remove first listener
          removeListener1();

          // Trigger state change by connecting
          await fs.connectNow();

          // First listener should not have received new states (still just initial)
          expect(states1).toEqual([FileSystemState.DISCONNECTED]);

          // Second listener should have received all state changes
          expect(states2).toEqual([
            FileSystemState.DISCONNECTED,
            FileSystemState.CONNECTING,
            FileSystemState.CONNECTED,
          ]);

          removeListener2();
        },
        async () => {
          await server.connected;
        },
      );
    });

    describe("openFile", () => {
      it("should send open_file command and receive events", async () => {
        await runInParallel(
          async (sync) => {
            const file = fs.openFile("TASKS.md");
            const fileIterator = file.getEvents();
            const { value: event, done: done1 } = await fileIterator.next();
            expect(done1).toBe(false);
            expect(event).toEqual({
              type: "file_opened",
              handle: "1",
              content: "Initial content",
            });
            const { value: updateEvent, done: done2 } =
              await fileIterator.next();
            expect(done2).toBe(false);
            expect(updateEvent).toEqual({
              type: "file_updated",
              handle: "1",
              content: "Updated content",
            });

            file.close();
          },
          async (sync) => {
            await server.connected;
            await expect(server).toReceiveMessage({
              type: "open_file",
              handle: "1",
              path: "TASKS.md",
            });

            // Send file_opened response
            server.send({
              type: "file_opened",
              handle: "1",
              content: "Initial content",
            });

            // Simulate external change
            server.send({
              type: "file_updated",
              handle: "1",
              content: "Updated content",
            });
          },
        );
      });

      it("should handle file opening errors", async () => {
        await runInParallel(
          async () => {
            const file = fs.openFile("nonexistent.md");
            const fileIterator = file.getEvents();
            await expect(fileIterator.next()).rejects.toThrow("File not found");
            file.close();
          },
          async () => {
            await server.connected;
            await expect(server).toReceiveMessage({
              type: "open_file",
              handle: "1",
              path: "nonexistent.md",
            });
            server.send({
              type: "error",
              message: "File not found",
            });
          },
        );
      });

      it("should close generator when file is closed", async () => {
        await runInParallel(
          async () => {
            const file = fs.openFile("TASKS.md");
            const fileIterator = file.getEvents();

            // Wait for initial file_opened event
            await fileIterator.next();

            file.close();

            const { done } = await fileIterator.next();
            expect(done).toBe(true);
          },
          async () => {
            await server.connected;
            await expect(server).toReceiveMessage({
              type: "open_file",
              handle: "1",
              path: "TASKS.md",
            });
            server.send({
              type: "file_opened",
              handle: "1",
              content: "Initial content",
            });
            await expect(server).toReceiveMessage({
              type: "close_file",
              handle: "1",
            });
          },
        );
        // Closing does *not* depend on server response
      });
    });
  });

  describe("writeFile", () => {
    it("should send write_file command and return new content", async () => {
      await runInParallel(
        async () => {
          const file = fs.openFile("TASKS.md");

          const eventsIterator = file.getEvents();
          expect((await eventsIterator.next()).value).toEqual({
            type: "file_opened",
            handle: "1",
            content: "old content",
          });

          const result = await file.writeFile("old content", "new content");
          expect(result).toBe("merged content");

          expect((await eventsIterator.next()).value).toEqual({
            type: "file_written",
            handle: "1",
            content: "merged content",
          });

          file.close();
        },
        async () => {
          await server.connected;

          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            handle: "1",
            content: "old content",
          });

          await expect(server).toReceiveMessage({
            type: "write_file",
            handle: "1",
            last_content: "old content",
            new_content: "new content",
          });

          server.send({
            type: "file_written",
            handle: "1",
            content: "merged content",
          });
        },
      );
    });

    it("should handle write errors", async () => {
      await runInParallel(
        async () => {
          const file = fs.openFile("TASKS.md");
          const fileIterator = file.getEvents();
          await fileIterator.next();
          await expect(file.writeFile("old", "new")).rejects.toThrow(
            "Permission denied",
          );
          file.close();
        },
        async () => {
          await server.connected;

          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            handle: "1",
            content: "old",
          });

          await expect(server).toReceiveMessage({
            type: "write_file",
            handle: "1",
            last_content: "old",
            new_content: "new",
          });

          // Send error response
          server.send({
            type: "error",
            message: "Permission denied",
          });
        },
      );
    });

    it("should handle unexpected response type", async () => {
      await runInParallel(
        async () => {
          const file = fs.openFile("TASKS.md");
          const eventsIterator = file.getEvents();
          let first = await eventsIterator.next();
          expect(first.value.type).toEqual("file_opened");

          await expect(
            file.writeFile("old content", "new content"),
          ).rejects.toThrow("Unexpected response type: committed");
        },
        async () => {
          await server.connected;

          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            handle: "1",
            content: "old content",
          });

          await expect(server).toReceiveMessage({
            type: "write_file",
            handle: "1",
            last_content: "old content",
            new_content: "new content",
          });

          // Send unexpected response
          server.send({
            type: "committed",
          });
        },
      );
    });
  });

  describe("commit", () => {
    it("should send commit command and complete successfully", async () => {
      await runInParallel(
        async () => {
          await expect(
            fs.commit("Test commit message"),
          ).resolves.toBeUndefined();
        },
        async () => {
          await server.connected;

          // Verify the command was sent correctly
          await expect(server).toReceiveMessage({
            type: "commit",
            message: "Test commit message",
          });

          // Send successful response
          server.send({
            type: "committed",
          });
        },
      );
    });

    it("should handle commit errors", async () => {
      await runInParallel(
        async () => {
          await expect(fs.commit("Test commit message")).rejects.toThrow(
            "Nothing to commit",
          );
        },
        async () => {
          await server.connected;

          await expect(server).toReceiveMessage({
            type: "commit",
            message: "Test commit message",
          });

          // Send error response
          server.send({
            type: "error",
            message: "Nothing to commit",
          });
        },
      );
    });
  });

  describe("real-time notification system", () => {
    it("should handle multiple files receiving updates simultaneously", async () => {
      await runInParallel(
        async () => {
          // Open both files
          const tasksFile = fs.openFile("TASKS.md");
          const tasksIterator = tasksFile.getEvents();
          const notesFile = fs.openFile("notes.md");
          const notesIterator = notesFile.getEvents();

          // Get initial events
          await tasksIterator.next();
          await notesIterator.next();

          // Both should receive their respective updates
          const tasksUpdate = await tasksIterator.next();
          const notesUpdate = await notesIterator.next();

          expect(tasksUpdate.value.content).toBe("Updated tasks");
          expect(notesUpdate.value.content).toBe("Updated notes");

          tasksFile.close();
          notesFile.close();
        },
        async () => {
          await server.connected;

          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            handle: "1",
            content: "Tasks",
          });

          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "2",
            path: "notes.md",
          });

          server.send({
            type: "file_opened",
            handle: "2",
            content: "Notes",
          });

          // Send updates to both files.

          server.send({
            type: "file_updated",
            handle: "1",
            content: "Updated tasks",
          });

          server.send({
            type: "file_updated",
            handle: "2",
            content: "Updated notes",
          });
        },
      );
    });
  });

  describe("Connection states and reconnection", () => {
    it("should handle multiple simultaneous connect() calls", async () => {
      await runInParallel(
        async () => {
          const commitPromise1 = fs.commit("Initial commit");
          const commitPromise2 = fs.commit("Second commit");

          // All promises should resolve
          await expect(commitPromise1).resolves.toBeUndefined();
          await expect(commitPromise2).resolves.toBeUndefined();
        },
        async () => {
          await server.connected;

          // Handle commands in order
          await expect(server).toReceiveMessage({
            type: "commit",
            message: "Initial commit",
          });

          server.send({
            type: "committed",
          });

          await expect(server).toReceiveMessage({
            type: "commit",
            message: "Second commit",
          });

          server.send({
            type: "committed",
          });
        },
      );
    });

    async function waitForStateChange(fs: FileSystem, state: FileSystemState) {
      if (fs.getState() === state) {
        return;
      }

      return Promise.race([
        new Promise<void>((resolve) => {
          const removeListener = fs.addStateListener((newState) => {
            if (newState === state) {
              removeListener();
              resolve();
            }
          });
        }),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("Timeout waiting for state")),
            1000,
          ),
        ),
      ]);
    }

    it("should transition to RECONNECT_WAIT on connection loss with open files", async () => {
      const __CONNECTED__ = "connected";

      await runInParallel(
        async (sync) => {
          // Open a file first
          const file = fs.openFile("TASKS.md");
          const fileIterator = file.getEvents();
          await fileIterator.next();
          expect(fs.getState()).toBe(FileSystemState.CONNECTED);

          sync.signal(__CONNECTED__); // ⏰

          // Should transition to RECONNECT_WAIT (not DISCONNECTED) because file is open
          await waitForStateChange(fs, FileSystemState.RECONNECT_WAIT);

          // Clean up
          file.close();
        },
        async (sync) => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            path: "TASKS.md",
            handle: "1",
          });
          server.send({
            type: "file_opened",
            handle: "1",
            content: "Initial content",
          });
          await sync.wait(__CONNECTED__); // 💤

          // Close connection
          server.close();
        },
      );
    });

    it("should transition to DISCONNECTED on connection loss without open files", async () => {
      const __CONNECTED__ = "connected";

      await runInParallel(
        async (sync) => {
          // Make a simple operation without keeping files open
          await fs.commit("Some changes");

          expect(fs.getState()).toBe(FileSystemState.CONNECTED);
          sync.signal(__CONNECTED__); // ⏰

          // Should transition to DISCONNECTED (not RECONNECT_WAIT) because no files are open
          await waitForStateChange(fs, FileSystemState.DISCONNECTED);
        },
        async (sync) => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "commit",
            message: "Some changes",
          });
          server.send({
            type: "committed",
          });
          await sync.wait(__CONNECTED__); // 💤

          // Close connection
          server.close();
        },
      );
    });

    it("should reestablish open files on reconnection", async () => {
      const __FILE_OPENED__ = "file opened";
      const __NEW_SERVER__ = "new server";

      await runInParallel(
        async (sync) => {
          // Initial connection and file opening
          const file = fs.openFile("TASKS.md");
          const fileIterator = file.getEvents();
          await fileIterator.next();

          sync.signal(__FILE_OPENED__);
          await sync.wait(__NEW_SERVER__);

          // Manual reconnection
          await fs.connectNow();

          // Should receive file_updated event (not file_opened) since content changed
          const { value: updateEvent } = await fileIterator.next();
          expect(updateEvent).toEqual({
            type: "file_updated",
            handle: "1",
            content: "v2",
          });

          file.close();
        },
        async (sync) => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            handle: "1",
            content: "v1",
          });
          await sync.wait(__FILE_OPENED__);

          // Simulate connection loss
          server.close();
          server = new WS(WS_URL, { jsonProtocol: true });

          sync.signal(__NEW_SERVER__);

          await server.connected;

          // Should receive reestablishment command for open file
          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            handle: "1",
            content: "v2", // Content changed
          });
        },
      );
    });

    it("should not send file_updated on reconnection if content unchanged", async () => {
      const __FILE_OPENED__ = "file opened";
      const __NEW_SERVER__ = "new server";

      // Initial connection and file opening
      const file = fs.openFile("TASKS.md");
      const fileIterator = file.getEvents();
      const receivedEvents: FileEvent[] = [];

      await runInParallel(
        async (sync) => {
          await fileIterator.next();
          sync.signal(__FILE_OPENED__); // ⏰

          for await (const event of fileIterator) {
            receivedEvents.push(event);
          }
        },
        async (sync) => {
          await sync.wait(__FILE_OPENED__); // 💤
          await sync.wait(__NEW_SERVER__); // 💤
          await fs.commit("Some changes"); // Trigger reconnection

          // At the above point, we've *received* any updated events from the
          // reconnection, make sure they are delivered to receivedEvents
          // by giving the event loop a tick.
          await new Promise((resolve) => setTimeout(resolve, 0));

          file.close();
        },
        async (sync) => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            handle: "1",
            content: "v1",
          });
          await sync.wait(__FILE_OPENED__); // 💤

          // Simulate connection loss
          server.close();
          server = new WS(WS_URL, { jsonProtocol: true });

          sync.signal(__NEW_SERVER__); // ⏰

          await server.connected;

          // Should receive reestablishment command for open file
          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });

          server.send({
            type: "file_opened",
            handle: "1",
            content: "v1", // Content unchanged
          });

          await expect(server).toReceiveMessage({
            type: "commit",
            message: "Some changes",
          });
          server.send({
            type: "committed",
          });
        },
      );

      expect(receivedEvents).toEqual([]);
    });

    it("should provide public connectNow() method", async () => {
      await runInParallel(
        async (cp) => {
          expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);
          await fs.connectNow();
          expect(fs.getState()).toBe(FileSystemState.CONNECTED);
        },
        async (cp) => {
          await server.connected;
        },
      );
    });

    it("should handle file reestablishment failures gracefully", async () => {
      const __FILE_OPENED__ = "file opened";
      const __NEW_SERVER__ = "new server";

      // Initial connection and file opening
      await runInParallel(
        async (sync) => {
          const file = fs.openFile("TASKS.md");
          const fileIterator = file.getEvents();

          await fileIterator.next();
          sync.signal(__FILE_OPENED__); // ⏰
          await sync.wait(__NEW_SERVER__); // 💤
          await fs.connectNow();

          // Connection should still be successful despite file error
          expect(fs.getState()).toBe(FileSystemState.CONNECTED);

          file.close();
        },
        async (sync) => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            handle: "1",
            content: "content",
          });
          await sync.wait(__FILE_OPENED__); // 💤

          // Simulate connection loss
          server.close();
          server = new WS(WS_URL, { jsonProtocol: true });

          sync.signal(__NEW_SERVER__); // ⏰

          await server.connected;

          // Should receive reestablishment command
          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });

          // Send error response (file might have been deleted)
          server.send({
            type: "error",
            message: "File not found",
          });
        },
      );
    });

    it("should clear reconnection timeout on manual disconnect", async () => {
      const __CONNECTED__ = "connected";

      await runInParallel(
        async (sync) => {
          // Trigger
          const file = fs.openFile("TASKS.md");
          const fileIterator = file.getEvents();
          await fileIterator.next();

          sync.signal(__CONNECTED__); // ⏰
          waitForStateChange(fs, FileSystemState.RECONNECT_WAIT);

          // Manual disconnect should clear timeouts and go to DISCONNECTED
          fs.disconnect();
          expect(fs.getState()).toBe(FileSystemState.DISCONNECTED);

          file.close();
        },
        async (sync) => {
          await server.connected;
          await expect(server).toReceiveMessage({
            type: "open_file",
            handle: "1",
            path: "TASKS.md",
          });
          server.send({
            type: "file_opened",
            handle: "1",
            content: "content",
          });

          await sync.wait(__CONNECTED__); // 💤
          // Close connection to trigger reconnection state
          server.close();
        },
      );
    });
  });
});
