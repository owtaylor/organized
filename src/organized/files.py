"""
WebSocket router for file system operations.

This module implements the WebSocket protocol for the file system as described
in FILESYSTEM_DESIGN.md Phase 5.
"""

import asyncio
from typing import Dict, Optional
from pathlib import Path

from fastapi import APIRouter, Depends, WebSocketDisconnect
from fastapi.websockets import WebSocket

from .file_system import FileSystem, FileSystemWatcher
from .tasks import GIT_CHECKOUT_LOCATION, ensure_git_repo


class Connection(FileSystemWatcher):
    """
    Manages a single WebSocket connection and its file subscriptions.
    Acts as both a context manager and a FileSystemWatcher.
    """

    def __init__(self, websocket: WebSocket, file_system: FileSystem):
        self.websocket = websocket
        self.file_system = file_system
        # Track open handles: {handle: filename}
        self.open_handles: Dict[str, str] = {}
        # Track files to handles: {filename: set of handles}
        self.file_handles: Dict[str, set] = {}

    async def __aenter__(self):
        """Async context manager entry."""
        await self.websocket.accept()
        self.file_system.add_watcher(self)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit - cleanup all resources."""
        # Close all files opened by this connection
        for filename, handles in list(self.file_handles.items()):
            for _ in handles:
                self.file_system.close_file(filename)

        # Remove this watcher from the file system
        self.file_system.remove_watcher(self)

    def on_file_change(self, filename: str, content: str, source_handle: Optional[str] = None) -> None:
        """
        Handle file changes from the FileSystem.
        Forward changes to the WebSocket connection if this connection is watching the file.
        """
        if filename in self.file_handles:
            # Send file_updated to all handles except the source handle
            for handle in self.file_handles[filename]:
                if handle != source_handle:
                    asyncio.create_task(self._send_file_updated(handle, content))

    async def _send_file_updated(self, handle: str, content: str):
        """Send file_updated event to the WebSocket connection."""
        try:
            await self.websocket.send_json({
                "type": "file_updated",
                "handle": handle,
                "content": content
            })
        except Exception:
            # Connection might be closed, ignore the error
            pass

    def open_file(self, filename: str, handle: str) -> str:
        """
        Open a file with a specific handle and track it for this connection.
        Returns the file content.
        """
        if handle in self.open_handles:
            raise ValueError(f"Handle '{handle}' is already in use")

        # Open the file in the file system first
        content = self.file_system.open_file(filename)

        # Track the handle
        self.open_handles[handle] = filename
        if filename not in self.file_handles:
            self.file_handles[filename] = set()
        self.file_handles[filename].add(handle)

        return content

    def close_file(self, handle: str) -> str:
        """
        Close a file handle for this connection.
        Returns the filename that was closed.
        """
        if handle not in self.open_handles:
            raise ValueError(f"Invalid handle: {handle}")

        filename = self.open_handles[handle]

        # Remove handle tracking
        del self.open_handles[handle]
        self.file_handles[filename].remove(handle)
        if not self.file_handles[filename]:
            del self.file_handles[filename]

        # Close in the file system
        self.file_system.close_file(filename)

        return filename

    def is_handle_valid(self, handle: str) -> bool:
        """Check if a handle is valid for this connection."""
        return handle in self.open_handles


# Global file system instance
_file_system: Optional[FileSystem] = None


def get_file_system() -> FileSystem:
    """Dependency to get the FileSystem instance."""
    global _file_system
    
    if _file_system is None:
        ensure_git_repo()
        _file_system = FileSystem(GIT_CHECKOUT_LOCATION)
    
    return _file_system


# Create the router
router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, fs: FileSystem = Depends(get_file_system)):
    """WebSocket endpoint for file system operations."""
    async with Connection(websocket, fs) as connection:
        try:
            while True:
                data = await websocket.receive_json()
                await handle_command(connection, data)
                
        except WebSocketDisconnect:
            pass
        # Cleanup is handled automatically by the context manager


async def handle_command(connection: Connection, data: dict):
    """Handle a WebSocket command from the client."""
    command_type = data.get("type")
    
    try:
        if command_type == "open_file":
            await handle_open_file(connection, data)
        elif command_type == "close_file":
            await handle_close_file(connection, data)
        elif command_type == "write_file":
            await handle_write_file(connection, data)
        elif command_type == "commit":
            await handle_commit(connection, data)
        else:
            await connection.websocket.send_json({
                "type": "error",
                "message": f"Unknown command type: {command_type}"
            })
    except Exception as e:
        await connection.websocket.send_json({
            "type": "error",
            "message": str(e)
        })


async def handle_open_file(connection: Connection, data: dict):
    """Handle open_file command."""
    path = data.get("path")
    handle = data.get("handle")

    if not path:
        await connection.websocket.send_json({
            "type": "error",
            "message": "Missing required field: path"
        })
        return

    if not handle:
        await connection.websocket.send_json({
            "type": "error",
            "message": "Missing required field: handle"
        })
        return

    try:
        # Open the file with the handle
        content = connection.open_file(path, handle)

        await connection.websocket.send_json({
            "type": "file_opened",
            "path": path,
            "handle": handle,
            "content": content
        })
    except Exception as e:
        await connection.websocket.send_json({
            "type": "error",
            "path": path,
            "message": str(e)
        })


async def handle_close_file(connection: Connection, data: dict):
    """Handle close_file command."""
    handle = data.get("handle")

    if not handle:
        await connection.websocket.send_json({
            "type": "error",
            "message": "Missing required field: handle"
        })
        return

    try:
        # Close the file handle
        filename = connection.close_file(handle)

        await connection.websocket.send_json({
            "type": "file_closed",
            "handle": handle
        })
    except Exception as e:
        await connection.websocket.send_json({
            "type": "error",
            "message": str(e)
        })


async def handle_write_file(connection: Connection, data: dict):
    """Handle write_file command."""
    handle = data.get("handle")
    last_content = data.get("last_content", "")
    new_content = data.get("new_content", "")

    if not handle:
        await connection.websocket.send_json({
            "type": "error",
            "message": "Missing required field: handle"
        })
        return

    if not connection.is_handle_valid(handle):
        await connection.websocket.send_json({
            "type": "error",
            "message": "Invalid handle"
        })
        return

    try:
        filename = connection.open_handles[handle]
        result_content = connection.file_system.write_file(
            filename, last_content, new_content, source=(connection, handle)
        )

        await connection.websocket.send_json({
            "type": "file_written",
            "handle": handle,
            "content": result_content
        })
    except Exception as e:
        await connection.websocket.send_json({
            "type": "error",
            "message": str(e)
        })


async def handle_commit(connection: Connection, data: dict):
    """Handle commit command."""
    message = data.get("message", "")
    if not message:
        await connection.websocket.send_json({
            "type": "error",
            "message": "Missing required field: message"
        })
        return
    
    try:
        connection.file_system.commit(message)
        await connection.websocket.send_json({
            "type": "committed"
        })
        
        # After commit, notify all connections watching @files if they changed
        # This would require checking which @files are open and if they changed
        # For now, we'll leave this as a TODO as it requires more complex logic
        
    except Exception as e:
        await connection.websocket.send_json({
            "type": "error",
            "message": str(e)
        })