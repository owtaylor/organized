import pytest
import json
import tempfile
from pathlib import Path
import subprocess
import asyncio
from unittest.mock import patch, AsyncMock

from fastapi.testclient import TestClient

from src.organized.main import app
from src.organized.file_system import FileSystem
from src.organized.files import get_file_system


@pytest.fixture
def git_repo():
    """Create a temporary git repository for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        repo_path = Path(temp_dir)

        # Initialize git repo
        subprocess.run(["git", "init"], cwd=repo_path, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=repo_path,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"], cwd=repo_path, check=True
        )

        # Create initial commit
        test_file = repo_path / "test.txt"
        test_file.write_text("initial content")
        subprocess.run(["git", "add", "test.txt"], cwd=repo_path, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Initial commit"], cwd=repo_path, check=True
        )

        yield repo_path


@pytest.fixture
def file_system(git_repo):
    """Create a FileSystem instance for testing."""
    return FileSystem(git_repo)


@pytest.fixture
def client(file_system):
    """Create a TestClient with dependency override."""
    app.dependency_overrides[get_file_system] = lambda: file_system
    with TestClient(app) as client:
        yield client


class TestBasicWebSocketConnection:
    """Test basic WebSocket connection functionality."""

    def test_websocket_connection_establishes(self, client):
        """Test that WebSocket connection can be established."""
        with client.websocket_connect("/ws") as websocket:
            # Send a test command to verify connection works
            websocket.send_json({"type": "invalid_test"})
            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Unknown command type" in response["message"]


class TestOpenFileCommand:
    """Test the open_file command and file_opened event."""

    def test_open_existing_file(self, client, git_repo):
        """Test opening an existing file returns file_opened event."""
        # Create a test file
        test_file = git_repo / "TASKS.md"
        test_file.write_text("# Test Tasks\n\nHello world")

        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "open_file",
                "path": "TASKS.md",
                "handle": "handle1"
            })

            response = websocket.receive_json()
            assert response["type"] == "file_opened"
            assert response["path"] == "TASKS.md"
            assert response["handle"] == "handle1"
            assert response["content"] == "# Test Tasks\n\nHello world"

    def test_open_nonexistent_file_returns_error(self, client):
        """Test that opening a non-existent file returns an error event."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "open_file",
                "path": "nonexistent.md",
                "handle": "handle1"
            })

            response = websocket.receive_json()
            assert response["type"] == "error"
            assert response["path"] == "nonexistent.md"

    def test_open_file_missing_handle_returns_error(self, client):
        """Test that open_file without handle returns error."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "open_file",
                "path": "test.md"
                # Missing "handle" field
            })

            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Missing required field: handle" in response["message"]

    def test_open_file_missing_path_returns_error(self, client):
        """Test that open_file without path returns error."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "open_file",
                "handle": "handle1"
                # Missing "path" field
            })

            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Missing required field: path" in response["message"]

    def test_open_at_file_committed_version(self, client, git_repo):
        """Test opening @file paths for committed versions."""
        # Create and commit a file
        test_file = git_repo / "committed.md"
        test_file.write_text("committed content")
        subprocess.run(["git", "add", "committed.md"], cwd=git_repo, check=True)
        subprocess.run(["git", "commit", "-m", "Add committed file"], cwd=git_repo, check=True)

        # Modify the file after commit
        test_file.write_text("modified content")

        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "open_file",
                "path": "@committed.md",
                "handle": "handle1"
            })

            response = websocket.receive_json()
            assert response["type"] == "file_opened"
            assert response["path"] == "@committed.md"
            assert response["handle"] == "handle1"
            assert response["content"] == "committed content"


class TestCloseFileCommand:
    """Test the close_file command and file_closed event."""

    def test_close_opened_file(self, client, git_repo):
        """Test closing an opened file returns file_closed event."""
        test_file = git_repo / "test.md"
        test_file.write_text("test content")

        with client.websocket_connect("/ws") as websocket:
            # First open the file
            websocket.send_json({
                "type": "open_file",
                "path": "test.md",
                "handle": "handle1"
            })
            websocket.receive_json()  # Skip file_opened event

            # Now close the file
            websocket.send_json({
                "type": "close_file",
                "handle": "handle1"
            })

            response = websocket.receive_json()
            assert response["type"] == "file_closed"
            assert response["handle"] == "handle1"

    def test_close_file_missing_handle_returns_error(self, client):
        """Test that close_file without handle returns error."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "close_file"
                # Missing "handle" field
            })

            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Missing required field: handle" in response["message"]

    def test_close_invalid_handle_returns_error(self, client):
        """Test that closing an invalid handle returns error."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "close_file",
                "handle": "invalid_handle"
            })

            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Invalid handle" in response["message"]


class TestWriteFileCommand:
    """Test the write_file command and file_written event."""

    def test_write_to_opened_file(self, client, git_repo):
        """Test writing to an opened file returns file_written event."""
        test_file = git_repo / "test.md"
        test_file.write_text("original content")

        with client.websocket_connect("/ws") as websocket:
            # First open the file
            websocket.send_json({
                "type": "open_file",
                "path": "test.md",
                "handle": "handle1"
            })
            websocket.receive_json()  # Skip file_opened event

            # Now write to the file
            websocket.send_json({
                "type": "write_file",
                "handle": "handle1",
                "last_content": "original content",
                "new_content": "updated content"
            })

            response = websocket.receive_json()
            assert response["type"] == "file_written"
            assert response["handle"] == "handle1"
            assert response["content"] == "updated content"

    def test_write_file_missing_handle_returns_error(self, client):
        """Test that write_file without handle returns error."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "write_file",
                "last_content": "test",
                "new_content": "test2"
                # Missing "handle" field
            })

            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Missing required field: handle" in response["message"]

    def test_write_file_invalid_handle_returns_error(self, client):
        """Test that write_file with invalid handle returns error."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "write_file",
                "handle": "invalid_handle",
                "last_content": "test",
                "new_content": "test2"
            })

            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Invalid handle" in response["message"]


class TestCommitCommand:
    """Test the commit command and committed event."""

    def test_commit_with_message(self, client, git_repo):
        """Test commit command sends committed event."""
        # Create and modify a file
        test_file = git_repo / "test.md"
        test_file.write_text("content to commit")
        
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "commit",
                "message": "Test commit\n\nThis is a test commit message"
            })
            
            response = websocket.receive_json()
            assert response["type"] == "committed"

    def test_commit_missing_message_returns_error(self, client):
        """Test that commit without message returns error."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "commit"
                # Missing "message" field
            })
            
            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Missing required field: message" in response["message"]


class TestHandleBasedFileManagement:
    """Test handle-based file management."""

    def test_multiple_handles_for_same_file(self, client, git_repo):
        """Test that multiple handles can be opened for the same file."""
        test_file = git_repo / "multihandle.md"
        test_file.write_text("test content")

        with client.websocket_connect("/ws") as websocket:
            # Open the file with first handle
            websocket.send_json({
                "type": "open_file",
                "path": "multihandle.md",
                "handle": "handle1"
            })
            response1 = websocket.receive_json()
            assert response1["type"] == "file_opened"
            assert response1["handle"] == "handle1"

            # Open the same file with second handle
            websocket.send_json({
                "type": "open_file",
                "path": "multihandle.md",
                "handle": "handle2"
            })
            response2 = websocket.receive_json()
            assert response2["type"] == "file_opened"
            assert response2["handle"] == "handle2"

            # Close first handle
            websocket.send_json({
                "type": "close_file",
                "handle": "handle1"
            })
            response = websocket.receive_json()
            assert response["type"] == "file_closed"
            assert response["handle"] == "handle1"

            # Close second handle
            websocket.send_json({
                "type": "close_file",
                "handle": "handle2"
            })
            response = websocket.receive_json()
            assert response["type"] == "file_closed"
            assert response["handle"] == "handle2"

    def test_closing_handle_twice_returns_error(self, client, git_repo):
        """Test that closing the same handle twice returns an error."""
        test_file = git_repo / "test.md"
        test_file.write_text("test content")

        with client.websocket_connect("/ws") as websocket:
            # Open the file
            websocket.send_json({
                "type": "open_file",
                "path": "test.md",
                "handle": "handle1"
            })
            websocket.receive_json()  # file_opened event

            # Close the handle
            websocket.send_json({
                "type": "close_file",
                "handle": "handle1"
            })
            response = websocket.receive_json()
            assert response["type"] == "file_closed"

            # Try to close the same handle again - should error
            websocket.send_json({
                "type": "close_file",
                "handle": "handle1"
            })
            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Invalid handle" in response["message"]


class TestFileUpdatedEvents:
    """Test file_updated events from external changes."""

    def test_file_updated_event_on_external_change(self, client, git_repo):
        """Test that external file changes trigger file_updated events."""
        # Create a test file
        test_file = git_repo / "watched.md"
        test_file.write_text("initial content")

        with client.websocket_connect("/ws") as websocket:
            # Open the file for watching
            websocket.send_json({
                "type": "open_file",
                "path": "watched.md",
                "handle": "handle1"
            })
            response = websocket.receive_json()
            assert response["type"] == "file_opened"
            assert response["handle"] == "handle1"
            assert response["content"] == "initial content"

            # Simulate external change to the file
            test_file.write_text("externally modified content")

            # Should receive file_updated event
            # NOTE: This will hang if file watching is not working properly.
            # websocket.receive_json() blocks until a message is received.
            # See https://github.com/Kludex/starlette/discussions/2195 for
            # a request to add timeout support to receive_json().
            response = websocket.receive_json()
            assert response["type"] == "file_updated"
            assert response["handle"] == "handle1"
            assert response["content"] == "externally modified content"

    def test_file_updated_sent_to_multiple_handles(self, client, git_repo):
        """Test that file_updated events are sent to all open handles for a file."""
        test_file = git_repo / "multiwatch.md"
        test_file.write_text("initial content")

        with client.websocket_connect("/ws") as websocket:
            # Open the file with multiple handles
            websocket.send_json({
                "type": "open_file",
                "path": "multiwatch.md",
                "handle": "handle1"
            })
            response1 = websocket.receive_json()
            assert response1["type"] == "file_opened"
            assert response1["handle"] == "handle1"

            websocket.send_json({
                "type": "open_file",
                "path": "multiwatch.md",
                "handle": "handle2"
            })
            response2 = websocket.receive_json()
            assert response2["type"] == "file_opened"
            assert response2["handle"] == "handle2"

            # Simulate external change to the file
            test_file.write_text("externally modified content")

            # Should receive file_updated events for both handles
            events_received = []
            for _ in range(2):
                response = websocket.receive_json()
                assert response["type"] == "file_updated"
                assert response["content"] == "externally modified content"
                events_received.append(response["handle"])

            # Both handles should have received updates
            assert "handle1" in events_received
            assert "handle2" in events_received

    def test_file_written_only_sent_to_writing_handle(self, client, git_repo):
        """Test that file_written events are only sent to the writing handle."""
        test_file = git_repo / "writetest.md"
        test_file.write_text("initial content")

        with client.websocket_connect("/ws") as websocket:
            # Open the file with multiple handles
            websocket.send_json({
                "type": "open_file",
                "path": "writetest.md",
                "handle": "handle1"
            })
            websocket.receive_json()  # file_opened

            websocket.send_json({
                "type": "open_file",
                "path": "writetest.md",
                "handle": "handle2"
            })
            websocket.receive_json()  # file_opened

            # Write to the file using handle1
            websocket.send_json({
                "type": "write_file",
                "handle": "handle1",
                "last_content": "initial content",
                "new_content": "updated content"
            })

            # Should receive file_written for handle1 and file_updated for handle2
            events_received = []
            for _ in range(2):
                response = websocket.receive_json()
                events_received.append((response["type"], response["handle"]))

            # Verify we got the right events for the right handles
            assert ("file_written", "handle1") in events_received
            assert ("file_updated", "handle2") in events_received


class TestErrorHandling:
    """Test error handling scenarios."""

    def test_invalid_command_type_returns_error(self, client):
        """Test that invalid command types return errors."""
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({
                "type": "invalid_command",
                "data": "test"
            })
            
            response = websocket.receive_json()
            assert response["type"] == "error"
            assert "Unknown command type: invalid_command" in response["message"]