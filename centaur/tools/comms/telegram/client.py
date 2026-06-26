"""Telegram Bot API client."""

import asyncio
from functools import wraps
from typing import Any

from centaur_sdk import secret
from telegram import Bot

from .error import TelegramError


def get_bot_token() -> str:
    """Get Telegram bot token from environment."""
    token = secret("TELEGRAM_BOT_TOKEN", "")
    if not token:
        raise RuntimeError(
            "TELEGRAM_BOT_TOKEN not set.\n"
            "Create a bot via @BotFather on Telegram and set the token."
        )
    return token


def run_async(func):
    """Decorator to run async functions synchronously."""

    @wraps(func)
    def wrapper(*args, **kwargs):
        return asyncio.get_event_loop().run_until_complete(func(*args, **kwargs))

    return wrapper


class TelegramClient:
    """High-level Telegram Bot API client for AI agents."""

    def __init__(self, token: str | None = None):
        """Initialize client with bot token."""
        self.token = token or get_bot_token()
        self._bot: Bot | None = None

    @property
    def bot(self) -> Bot:
        """Get or create bot instance."""
        if self._bot is None:
            self._bot = Bot(token=self.token)
        return self._bot

    async def get_me(self) -> dict[str, Any]:
        """Get bot info."""
        async with self.bot:
            me = await self.bot.get_me()
            return {
                "id": me.id,
                "username": me.username,
                "first_name": me.first_name,
                "can_join_groups": me.can_join_groups,
                "can_read_all_group_messages": me.can_read_all_group_messages,
            }

    async def send_message(
        self,
        chat_id: int | str,
        text: str,
        parse_mode: str | None = None,
        reply_to_message_id: int | None = None,
    ) -> dict[str, Any]:
        """Send a message to a chat."""
        async with self.bot:
            try:
                msg = await self.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    parse_mode=parse_mode,
                    reply_to_message_id=reply_to_message_id,
                )
                return {
                    "message_id": msg.message_id,
                    "chat_id": msg.chat.id,
                    "chat_type": msg.chat.type,
                    "chat_title": msg.chat.title or msg.chat.username,
                    "date": msg.date.isoformat(),
                    "text": msg.text,
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_updates(
        self,
        limit: int = 100,
        timeout: int = 0,
        offset: int | None = None,
    ) -> list[dict[str, Any]]:
        """Get recent updates (messages sent to the bot)."""
        async with self.bot:
            try:
                updates = await self.bot.get_updates(
                    limit=limit,
                    timeout=timeout,
                    offset=offset,
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

            results = []
            for update in updates:
                msg = update.message or update.edited_message or update.channel_post
                if msg:
                    results.append(
                        {
                            "update_id": update.update_id,
                            "message_id": msg.message_id,
                            "chat_id": msg.chat.id,
                            "chat_type": msg.chat.type,
                            "chat_title": msg.chat.title
                            or msg.chat.username
                            or msg.chat.first_name,
                            "from_user": msg.from_user.username if msg.from_user else None,
                            "from_id": msg.from_user.id if msg.from_user else None,
                            "text": msg.text or msg.caption or "",
                            "date": msg.date.isoformat(),
                        }
                    )
            return results

    async def get_chat(self, chat_id: int | str) -> dict[str, Any]:
        """Get chat info."""
        async with self.bot:
            try:
                chat = await self.bot.get_chat(chat_id=chat_id)
                return {
                    "id": chat.id,
                    "type": chat.type,
                    "title": chat.title,
                    "username": chat.username,
                    "first_name": chat.first_name,
                    "last_name": chat.last_name,
                    "description": chat.description,
                    "member_count": getattr(chat, "member_count", None),
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_chat_member_count(self, chat_id: int | str) -> int:
        """Get number of members in a chat."""
        async with self.bot:
            try:
                return await self.bot.get_chat_member_count(chat_id=chat_id)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def forward_message(
        self,
        chat_id: int | str,
        from_chat_id: int | str,
        message_id: int,
    ) -> dict[str, Any]:
        """Forward a message to another chat."""
        async with self.bot:
            try:
                msg = await self.bot.forward_message(
                    chat_id=chat_id,
                    from_chat_id=from_chat_id,
                    message_id=message_id,
                )
                return {
                    "message_id": msg.message_id,
                    "chat_id": msg.chat.id,
                    "date": msg.date.isoformat(),
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def delete_message(self, chat_id: int | str, message_id: int) -> bool:
        """Delete a message."""
        async with self.bot:
            try:
                return await self.bot.delete_message(chat_id=chat_id, message_id=message_id)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def set_webhook(self, url: str) -> bool:
        """Set webhook URL for receiving updates."""
        async with self.bot:
            try:
                return await self.bot.set_webhook(url=url)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def delete_webhook(self) -> bool:
        """Delete webhook and switch to polling."""
        async with self.bot:
            try:
                return await self.bot.delete_webhook()
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_webhook_info(self) -> dict[str, Any]:
        """Get current webhook status."""
        async with self.bot:
            try:
                info = await self.bot.get_webhook_info()
                return {
                    "url": info.url,
                    "has_custom_certificate": info.has_custom_certificate,
                    "pending_update_count": info.pending_update_count,
                    "last_error_date": info.last_error_date.isoformat()
                    if info.last_error_date
                    else None,
                    "last_error_message": info.last_error_message,
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")


# Sync convenience functions
def get_client(token: str | None = None) -> TelegramClient:
    """Get a TelegramClient instance."""
    return TelegramClient(token=token)


def send_message(chat_id: int | str, text: str, **kwargs) -> dict[str, Any]:
    """Send a message (sync wrapper)."""
    client = get_client()
    return asyncio.run(client.send_message(chat_id, text, **kwargs))


def get_updates(limit: int = 100, **kwargs) -> list[dict[str, Any]]:
    """Get updates (sync wrapper)."""
    client = get_client()
    return asyncio.run(client.get_updates(limit=limit, **kwargs))


def get_chat(chat_id: int | str) -> dict[str, Any]:
    """Get chat info (sync wrapper)."""
    client = get_client()
    return asyncio.run(client.get_chat(chat_id))


def _client() -> TelegramClient:
    return TelegramClient()
