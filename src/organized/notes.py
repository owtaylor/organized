import asyncio
import hashlib
import json
import logging
import subprocess
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
from pydantic import BaseModel

import yaml
from fastapi import HTTPException

from .config import get_config
from .gemini_utils import get_genai_client

# --- Configuration ---
GIT_CHECKOUT_LOCATION = Path.home() / ".local" / "share" / "organized" / "main"
AUDIO_NOTES_DIR = Path.home() / ".local" / "share" / "organized" / "audio"
NOTES_DIR = GIT_CHECKOUT_LOCATION / "notes"
NOTES_METADATA_PATH = GIT_CHECKOUT_LOCATION / "notes.yaml"
CONTEXT_FILE_PATH = GIT_CHECKOUT_LOCATION / "CONTEXT.md"


# --- Data Models ---
class Note(BaseModel):
    hash: str
    date: str
    title: Optional[str] = None
    processed: bool = False


# --- Helper Functions ---


def get_note_metadata() -> List[Dict[str, Any]]:
    """Loads the notes metadata from notes.yaml."""
    if not NOTES_METADATA_PATH.exists():
        return []
    return yaml.safe_load(NOTES_METADATA_PATH.read_text())


def save_note_metadata(notes: List[Dict[str, Any]]):
    """Saves the notes metadata to notes.yaml."""
    NOTES_METADATA_PATH.write_text(yaml.dump(notes, sort_keys=False))


def get_file_hash(file_path: Path) -> str:
    """Calculates the SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(8192):
            sha256.update(chunk)
    return sha256.hexdigest()


def get_audio_file_date(file_path: Path) -> str:
    """Extracts the recording date from an audio file using mediainfo."""
    try:
        result = subprocess.run(
            ["mediainfo", "--Output=JSON", str(file_path)],
            capture_output=True,
            text=True,
            check=True,
        )
        media_info = json.loads(result.stdout)
        encoded_date_str = media_info["media"]["track"][0]["Encoded_Date"]
        # The date is in format 'YYYY-MM-DD HH:MM:SS UTC'
        dt = datetime.strptime(encoded_date_str, "%Y-%m-%d %H:%M:%S %Z")
        return dt.strftime("%Y-%m-%d-%H:%M:%S")
    except (subprocess.CalledProcessError, KeyError, IndexError) as e:
        raise HTTPException(
            status_code=500, detail=f"Error getting date from {file_path.name}: {e}"
        ) from e


async def transcribe_audio(file_path: Path) -> str:
    """Transcribes an audio file using the Gemini API."""

    context = ""
    if CONTEXT_FILE_PATH.exists():
        context = f"""
Here is some context to help with the transcription:
{CONTEXT_FILE_PATH.read_text()}
"""
    else:
        context = ""

    prompt = f"""
Your are a transcriber for my personal audio notes. You should try to transcribe
what I say literally, except for ums, ers, and repetitions which shoulbe left out.
If things are unclear, make your best guess based on the context.

Please transcribe the following audio file. Use markdown as appropriate.
The transcription should start with a toplevel heading with a brief summary
of the contents of the note, and when I change topic, add a section header.
{context}
"""
    client = get_genai_client()
    audio_file = client.files.upload(file=str(file_path))
    logging.info(f"Requesting transcription for {file_path.name}")
    response = client.models.generate_content(
        model="gemini-1.5-flash", contents=[prompt, audio_file]
    )
    logging.info(f"Transcription complete for {file_path.name}")
    logging.info(f"Usage metadata: {response.usage_metadata}")

    if response.text is None:
        raise RuntimeError("No transcription returned")

    return response.text


# --- API Implementation ---


def get_notes_list() -> List[Dict[str, Any]]:
    """Returns the list of notes from notes.yaml."""
    return get_note_metadata()


def get_note_by_hash(note_hash: str) -> str:
    """Returns the transcribed note for the given hash."""
    notes = get_note_metadata()
    note_entry = next((n for n in notes if n["hash"] == note_hash), None)
    if not note_entry:
        raise HTTPException(status_code=404, detail="Note not found")

    transcription_path = NOTES_DIR / f"{note_entry['date']}.md"
    if not transcription_path.exists():
        raise HTTPException(status_code=404, detail="Transcription not found")

    return transcription_path.read_text()


async def sync_notes() -> Dict[str, str]:
    """
    Syncs audio notes, updates metadata, and transcribes new notes.
    """
    # 1. Create directories if they don't exist
    AUDIO_NOTES_DIR.mkdir(parents=True, exist_ok=True)
    NOTES_DIR.mkdir(parents=True, exist_ok=True)

    # 2. Sync notes from remote
    config = get_config()
    sync_command = config.get("audio_notes", {}).get("sync_command")
    if sync_command:
        # Replace $dest with the actual audio notes directory
        sync_command = sync_command.replace("$dest", str(AUDIO_NOTES_DIR))
        process = await asyncio.create_subprocess_shell(
            sync_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Sync command failed: {stderr.decode()}",
            )

    # 3. Update notes.yaml with new notes
    notes = get_note_metadata()
    existing_hashes = {note["hash"] for note in notes}

    for audio_file in AUDIO_NOTES_DIR.iterdir():
        if audio_file.is_file():
            file_hash = get_file_hash(audio_file)
            if file_hash not in existing_hashes:
                date_str = get_audio_file_date(audio_file)
                notes.append(
                    {
                        "hash": file_hash,
                        "date": date_str,
                        "title": None,
                        "processed": False,
                    }
                )
                existing_hashes.add(file_hash)

    save_note_metadata(notes)

    # 4. Transcribe new notes
    for note in notes:
        transcription_path = NOTES_DIR / f"{note['date']}.md"
        if not transcription_path.exists():
            audio_file_path = None
            # Find the audio file by hash
            for f in AUDIO_NOTES_DIR.iterdir():
                if f.is_file() and get_file_hash(f) == note["hash"]:
                    audio_file_path = f
                    break

            if audio_file_path:
                transcription = await transcribe_audio(audio_file_path)
                transcription_path.write_text(transcription)

                # Extract title from the first heading
                first_line = transcription.splitlines()[0]
                if first_line.startswith("# "):
                    note["title"] = first_line[2:].strip()
                else:
                    note["title"] = "Untitled Note"

                save_note_metadata(notes)

    return {"message": "Notes synced successfully"}
