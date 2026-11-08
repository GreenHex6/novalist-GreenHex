#!/usr/bin/env python3
"""Post published stable GitHub release notes to Discord using a secret webhook."""

import argparse
import json
import os
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

ICON_URL = "https://raw.githubusercontent.com/Drommedhar/novalist-official/main/app/resources/icon.png"
GOLD = 0xD2A74F
DOWNLOAD_URL = "https://novalist.eu/#copy"


class NotificationError(RuntimeError):
    """An announcement could not be prepared or confirmed delivered."""


def format_notes(body: str) -> str:
    lines = []
    fenced = False
    for line in body.strip().splitlines():
        if line.startswith(("```", "~~~")):
            fenced = not fenced
        if not fenced:
            line = re.sub(r"^#{1,6}\s+(.+?)\s*#*$", r"**\1**", line)
        lines.append(line)
    return "\n".join(lines)


def discord_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def split_notes(notes: str) -> list[str]:
    chunks = []
    while discord_length(notes) > 3900:
        limit = 0
        size = 0
        for character in notes[:3900]:
            size += 2 if ord(character) > 0xFFFF else 1
            if size > 3900:
                break
            limit += 1
        boundary = notes.rfind("\n\n", 0, limit)
        if boundary > 0:
            boundary += 2
        else:
            boundary = notes.rfind("\n", 0, limit) + 1
        if boundary == 0:
            boundary = notes.rfind(" ", 0, limit) + 1
        if boundary == 0:
            boundary = limit
        heading = re.search(r"(?:^|\n\n)(\*\*[^*\n]+\*\*\n\n)$", notes[:boundary])
        if heading and heading.start(1) > 0:
            boundary = heading.start(1)
        chunks.append(notes[:boundary])
        notes = notes[boundary:]
    if notes:
        chunks.append(notes)
    return chunks


def embed_size(embed: dict) -> int:
    return (
        discord_length(embed["title"])
        + discord_length(embed["description"])
        + discord_length(embed["footer"]["text"])
    )


def build_messages(release: dict, *, test: bool = False) -> list[dict]:
    if release["draft"] or release["prerelease"]:
        raise NotificationError("Only published stable releases can be announced.")
    release_url = release["html_url"]
    repository_url, separator, _ = release_url.partition("/releases/tag/")
    if not separator or not repository_url.startswith("https://github.com/"):
        raise NotificationError("The release must have a GitHub release URL.")
    notes = format_notes(release["body"] or "") or "No release notes were provided."
    chunks = split_notes(notes)
    embeds = []
    for index, chunk in enumerate(chunks):
        title = f"Novalist {release['tag_name']}"
        if index:
            title += " | Release notes continued"
        footer = "Novalist | Release notes"
        if test:
            footer = "Test preview | " + footer
        embed = {
            "title": title[:256],
            "description": chunk,
            "color": GOLD,
            "footer": {"text": footer},
            "timestamp": release["published_at"],
        }
        if index == 0:
            embed.update(url=release_url, thumbnail={"url": ICON_URL})
        embeds.append(embed)
    messages = []
    for embed in embeds:
        if (
            not messages
            or sum(map(embed_size, messages[-1]["embeds"])) + embed_size(embed) > 6000
        ):
            messages.append(
                {
                    "username": "Novalist Releases",
                    "avatar_url": ICON_URL,
                    "allowed_mentions": {"parse": []},
                    "flags": 4096 if test else 0,
                    "embeds": [],
                }
            )
        messages[-1]["embeds"].append(embed)
    messages[-1]["components"] = [
        {
            "type": 1,
            "components": [
                {
                    "type": 2,
                    "style": 5,
                    "label": "Go to releases",
                    "url": f"{repository_url}/releases/latest",
                },
                {
                    "type": 2,
                    "style": 5,
                    "label": "Download current release",
                    "url": DOWNLOAD_URL,
                },
            ],
        }
    ]
    return messages


def webhook_endpoint(webhook: str) -> str:
    parts = urlsplit(webhook)
    if (
        parts.scheme != "https"
        or parts.netloc != "discord.com"
        or not re.fullmatch(r"/api/(?:v\d+/)?webhooks/\d+/[\w-]+", parts.path)
    ):
        raise NotificationError(
            "DISCORD_RELEASE_WEBHOOK_URL must be a Discord webhook URL."
        )
    query = dict(parse_qsl(parts.query))
    query["wait"] = "true"
    query["with_components"] = "true"
    return urlunsplit(parts._replace(query=urlencode(query), fragment=""))


def rate_limit_delay(error: HTTPError) -> float:
    try:
        delay = float(json.load(error)["retry_after"])
    except (ValueError, TypeError, KeyError):
        raise NotificationError(
            "Discord returned an invalid rate-limit response."
        ) from None
    if not 0 <= delay <= 60:
        raise NotificationError(
            "Discord rate limit exceeds the automatic retry window."
        )
    return delay


def send_message(webhook: str, payload: dict) -> str:
    request = Request(
        webhook_endpoint(webhook),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Novalist-Release-Notifier",
        },
        method="POST",
    )
    attempt = 0
    while True:
        try:
            with urlopen(request, timeout=30) as response:
                message = json.load(response)
            return message["id"]
        except HTTPError as error:
            if error.code != 429 or attempt == 2:
                raise NotificationError(
                    f"Discord rejected the announcement (HTTP {error.code})."
                ) from None
            attempt += 1
            time.sleep(rate_limit_delay(error))
        except (URLError, TimeoutError, OSError, ValueError, KeyError, TypeError):
            # A timeout can occur after delivery; retrying could post a duplicate.
            raise NotificationError(
                "Discord delivery could not be confirmed; check the channel before retrying."
            ) from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--preview", action="store_true", help="Print payloads without sending them"
    )
    parser.add_argument(
        "--test", action="store_true", help="Mark announcements as test previews"
    )
    args = parser.parse_args()
    try:
        messages = build_messages(json.load(sys.stdin.buffer), test=args.test)
        if args.preview:
            print(json.dumps(messages, indent=2))
            return 0
        webhook = os.environ.get("DISCORD_RELEASE_WEBHOOK_URL", "")
        if not webhook:
            raise NotificationError("DISCORD_RELEASE_WEBHOOK_URL is required.")
        for index, payload in enumerate(messages, 1):
            message_id = send_message(webhook, payload)
            print(
                f"Announcement {index}/{len(messages)} delivered (message {message_id})."
            )
        return 0
    except (NotificationError, ValueError, KeyError, TypeError) as error:
        message = (
            str(error)
            if isinstance(error, NotificationError)
            else "Invalid GitHub release JSON."
        )
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
