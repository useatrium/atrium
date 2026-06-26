"""Telegram MTProto client for user account access via Telethon."""

import os
from pathlib import Path
from typing import Any

from telethon import TelegramClient as TelethonClient
from telethon.tl.types import Channel, Chat, Message, User

from centaur_sdk import secret


def get_api_credentials() -> tuple[int, str]:
    """Get Telegram API credentials from environment."""
    api_id = secret("TELEGRAM_API_ID", "")
    api_hash = secret("TELEGRAM_API_HASH", "")

    if not api_id or not api_hash:
        raise RuntimeError(
            "TELEGRAM_API_ID and TELEGRAM_API_HASH not set.\n"
            "Get them from https://my.telegram.org/apps"
        )

    return int(api_id), api_hash


def get_session_path() -> Path:
    """Get path for Telethon session file."""
    session_dir = Path.home() / ".config" / "telegram"
    session_dir.mkdir(parents=True, exist_ok=True)
    return session_dir / "session"


class UserClient:
    """High-level Telegram MTProto client for user accounts."""

    def __init__(self, session_name: str | None = None):
        """Initialize client with API credentials."""
        self.api_id, self.api_hash = get_api_credentials()
        self.session_path = session_name or str(get_session_path())
        self._client: TelethonClient | None = None

    @property
    def client(self) -> TelethonClient:
        """Get or create Telethon client instance."""
        if self._client is None:
            self._client = TelethonClient(
                self.session_path,
                self.api_id,
                self.api_hash,
            )
        return self._client

    async def ensure_connected(self) -> None:
        """Ensure client is connected and authorized."""
        if not self.client.is_connected():
            await self.client.connect()

        if not await self.client.is_user_authorized():
            raise RuntimeError("Not logged in. Run 'telegram login' first to authenticate.")

    async def login(self, phone: str) -> dict[str, Any]:
        """Start login process with phone number."""
        if not self.client.is_connected():
            await self.client.connect()

        result = await self.client.send_code_request(phone)
        return {
            "status": "code_sent",
            "phone_code_hash": result.phone_code_hash,
            "phone": phone,
        }

    async def verify_code(self, phone: str, code: str, phone_code_hash: str) -> dict[str, Any]:
        """Complete login with verification code."""
        if not self.client.is_connected():
            await self.client.connect()

        try:
            await self.client.sign_in(phone, code, phone_code_hash=phone_code_hash)
            me = await self.client.get_me()
            return {
                "status": "logged_in",
                "user_id": me.id,
                "username": me.username,
                "first_name": me.first_name,
            }
        except Exception as e:
            if "Two-steps verification" in str(e) or "password" in str(e).lower():
                return {"status": "2fa_required"}
            raise

    async def verify_2fa(self, password: str) -> dict[str, Any]:
        """Complete login with 2FA password."""
        if not self.client.is_connected():
            await self.client.connect()

        await self.client.sign_in(password=password)
        me = await self.client.get_me()
        return {
            "status": "logged_in",
            "user_id": me.id,
            "username": me.username,
            "first_name": me.first_name,
        }

    async def get_me(self) -> dict[str, Any]:
        """Get current user info."""
        await self.ensure_connected()
        me = await self.client.get_me()
        return {
            "id": me.id,
            "username": me.username,
            "first_name": me.first_name,
            "last_name": me.last_name,
            "phone": me.phone,
        }

    async def get_entity(self, entity: str | int) -> dict[str, Any]:
        """Get entity (user/chat/channel) info."""
        await self.ensure_connected()

        ent = await self.client.get_entity(entity)

        result = {
            "id": ent.id,
            "type": type(ent).__name__.lower(),
        }

        if isinstance(ent, User):
            result.update(
                {
                    "username": ent.username,
                    "first_name": ent.first_name,
                    "last_name": ent.last_name,
                    "phone": ent.phone,
                    "is_bot": ent.bot,
                }
            )
        elif isinstance(ent, (Chat, Channel)):
            result.update(
                {
                    "title": ent.title,
                    "username": getattr(ent, "username", None),
                }
            )
            if isinstance(ent, Channel):
                result["megagroup"] = ent.megagroup
                result["broadcast"] = ent.broadcast

        return result

    async def get_messages(
        self,
        entity: str | int,
        limit: int = 50,
        offset_id: int = 0,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get messages from a chat/channel."""
        await self.ensure_connected()

        messages = []
        async for msg in self.client.iter_messages(
            entity,
            limit=limit,
            offset_id=offset_id,
            search=search,
        ):
            if not isinstance(msg, Message):
                continue

            sender_name = None
            if msg.sender:
                if hasattr(msg.sender, "first_name"):
                    sender_name = msg.sender.first_name
                    if msg.sender.last_name:
                        sender_name += f" {msg.sender.last_name}"
                elif hasattr(msg.sender, "title"):
                    sender_name = msg.sender.title

            messages.append(
                {
                    "id": msg.id,
                    "date": msg.date.isoformat() if msg.date else None,
                    "sender_id": msg.sender_id,
                    "sender_name": sender_name,
                    "text": msg.text or "",
                    "reply_to_msg_id": msg.reply_to_msg_id if msg.reply_to else None,
                    "forwards": msg.forwards,
                    "views": msg.views,
                }
            )

        return messages

    async def send_message(
        self,
        entity: str | int,
        text: str,
        reply_to: int | None = None,
    ) -> dict[str, Any]:
        """Send a message."""
        await self.ensure_connected()

        msg = await self.client.send_message(
            entity,
            text,
            reply_to=reply_to,
        )

        return {
            "id": msg.id,
            "date": msg.date.isoformat() if msg.date else None,
            "text": msg.text,
        }

    async def get_dialogs(self, limit: int = 50) -> list[dict[str, Any]]:
        """Get list of chats/dialogs."""
        await self.ensure_connected()

        dialogs = []
        async for dialog in self.client.iter_dialogs(limit=limit):
            dialogs.append(
                {
                    "id": dialog.id,
                    "name": dialog.name,
                    "type": type(dialog.entity).__name__.lower(),
                    "unread_count": dialog.unread_count,
                    "is_channel": dialog.is_channel,
                    "is_group": dialog.is_group,
                    "is_user": dialog.is_user,
                }
            )

        return dialogs

    async def search_messages(
        self,
        entity: str | int,
        query: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Search messages in a chat/channel."""
        return await self.get_messages(entity, limit=limit, search=query)

    async def disconnect(self) -> None:
        """Disconnect the client."""
        if self._client and self._client.is_connected():
            await self._client.disconnect()


# Convenience functions
def get_user_client() -> UserClient:
    """Get a UserClient instance."""
    return UserClient()
