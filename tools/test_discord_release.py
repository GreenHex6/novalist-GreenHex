"""Exercise release formatting and the Discord HTTP boundary without posting."""

import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from tools.discord_release import (
    NotificationError,
    build_messages,
    send_message,
    split_notes,
)

RELEASE = {
    "tag_name": "v3.7.0",
    "body": "### Added\n\n- **Notes** — keep your ideas.\n\n### Fixed\n\n- Saved zuverlässig.",
    "html_url": "https://github.com/Drommedhar/novalist-official/releases/tag/v3.7.0",
    "published_at": "2026-11-06T22:21:19Z",
    "draft": False,
    "prerelease": False,
}
WEBHOOK = "https://discord.com/api/webhooks/123/test-token"


class FormattingTests(unittest.TestCase):
    def test_branded_release_has_version_notes_and_latest_download(self):
        (message,) = build_messages(RELEASE)
        (embed,) = message["embeds"]
        self.assertEqual(embed["title"], "Novalist v3.7.0")
        self.assertEqual(embed["url"], RELEASE["html_url"])
        self.assertEqual(
            embed["description"],
            "**Added**\n\n- **Notes** — keep your ideas.\n\n**Fixed**\n\n- Saved zuverlässig.",
        )
        self.assertEqual(embed["color"], 0xD2A74F)
        self.assertEqual(embed["timestamp"], RELEASE["published_at"])
        buttons = message["components"][0]["components"]
        self.assertEqual(
            [button["label"] for button in buttons],
            ["Go to releases", "Download current release"],
        )
        self.assertEqual(
            buttons[0]["url"],
            "https://github.com/Drommedhar/novalist-official/releases/latest",
        )
        self.assertEqual(buttons[1]["url"], "https://novalist.eu/#copy")
        self.assertTrue(
            all(button["type"] == 2 and button["style"] == 5 for button in buttons)
        )
        self.assertEqual(message["allowed_mentions"], {"parse": []})

    def test_long_notes_are_complete_and_each_message_fits_discord(self):
        paragraphs = [
            f"- Change {index}: " + " ".join(["prose"] * 120) for index in range(35)
        ]
        notes = "\n\n".join(paragraphs)
        messages = build_messages({**RELEASE, "body": notes})
        descriptions = []
        self.assertGreater(len(messages), 1)
        for message in messages:
            self.assertLessEqual(len(message["embeds"]), 10)
            characters = 0
            for embed in message["embeds"]:
                self.assertLessEqual(len(embed["title"]), 256)
                self.assertLessEqual(len(embed["description"]), 4096)
                descriptions.append(embed["description"])
                characters += len(embed["title"]) + len(embed["description"])
                characters += len(embed["footer"]["text"])
                for field in embed.get("fields", []):
                    characters += len(field["name"]) + len(field["value"])
            self.assertLessEqual(characters, 6000)
            self.assertEqual(message["allowed_mentions"], {"parse": []})
        self.assertEqual("".join(descriptions), notes)
        self.assertTrue(all("components" not in message for message in messages[:-1]))
        self.assertIn("components", messages[-1])

    def test_two_embeds_fit_one_message_without_duplicate_urls(self):
        messages = build_messages({**RELEASE, "body": "x" * 4500})
        self.assertEqual(len(messages), 1)
        self.assertEqual(len(messages[0]["embeds"]), 2)
        urls = [embed["url"] for embed in messages[0]["embeds"] if "url" in embed]
        self.assertEqual(len(urls), len(set(urls)))

    def test_empty_notes_link_to_release(self):
        (message,) = build_messages({**RELEASE, "body": None})
        self.assertIn("No release notes", message["embeds"][0]["description"])

    def test_section_heading_stays_with_its_first_paragraph(self):
        notes = "x" * 3850 + "\n\n**Android alpha**\n\n" + "y" * 300
        chunks = split_notes(notes)
        self.assertTrue(chunks[1].startswith("**Android alpha**\n\n"))
        self.assertEqual("".join(chunks), notes)

    def test_supplementary_unicode_stays_within_discord_limits(self):
        notes = chr(0x20000) * 5000
        messages = build_messages({**RELEASE, "body": notes})
        descriptions = [
            embed["description"] for message in messages for embed in message["embeds"]
        ]
        self.assertEqual("".join(descriptions), notes)
        for description in descriptions:
            self.assertLessEqual(len(description.encode("utf-16-le")) // 2, 4096)

    def test_preview_is_marked_and_drafts_or_prereleases_cannot_be_announced(self):
        (message,) = build_messages(RELEASE, test=True)
        self.assertIn("Test preview", message["embeds"][0]["footer"]["text"])
        for flag in ("draft", "prerelease"):
            with self.subTest(flag=flag), self.assertRaises(NotificationError):
                build_messages({**RELEASE, flag: True})

    def test_preview_suppresses_push_notifications_for_every_message(self):
        release = {**RELEASE, "body": "release notes " * 1000}
        for message in build_messages(release, test=True):
            self.assertEqual(message["flags"], 4096)
        for message in build_messages(release):
            self.assertEqual(message.get("flags", 0), 0)


class DeliveryTests(unittest.TestCase):
    @patch("tools.discord_release.urlopen")
    def test_waits_for_delivery_and_returns_message_id(self, request):
        request.return_value = io.BytesIO(b'{"id":"456","channel_id":"789"}')
        (payload,) = build_messages(RELEASE)
        message_id = send_message(WEBHOOK + "?thread_id=42&wait=false", payload)
        sent = request.call_args.args[0]
        self.assertIn("wait=true", sent.full_url)
        self.assertIn("with_components=true", sent.full_url)
        self.assertIn("thread_id=42", sent.full_url)
        self.assertNotIn("wait=false", sent.full_url)
        self.assertEqual(json.loads(sent.data), payload)
        self.assertEqual(message_id, "456")

    @patch("tools.discord_release.time.sleep")
    @patch("tools.discord_release.urlopen")
    def test_rate_limit_is_retried(self, request, sleep):
        request.side_effect = [
            HTTPError(
                WEBHOOK, 429, "rate limit", {}, io.BytesIO(b'{"retry_after":0.5}')
            ),
            io.BytesIO(b'{"id":"456","channel_id":"789"}'),
        ]
        self.assertEqual(send_message(WEBHOOK, {}), "456")
        sleep.assert_called_once_with(0.5)

    @patch("tools.discord_release.urlopen")
    def test_errors_do_not_expose_webhook_or_retry_ambiguous_delivery(self, request):
        for error in (
            HTTPError(WEBHOOK, 400, WEBHOOK, {}, None),
            HTTPError(WEBHOOK, 500, WEBHOOK, {}, None),
            URLError(WEBHOOK),
            TimeoutError(WEBHOOK),
        ):
            with self.subTest(error=type(error).__name__):
                request.reset_mock()
                request.side_effect = error
                with self.assertRaises(NotificationError) as caught:
                    send_message(WEBHOOK, {})
                self.assertNotIn("test-token", str(caught.exception))
                self.assertEqual(request.call_count, 1)

    @patch("tools.discord_release.urlopen")
    def test_non_discord_urls_are_rejected_before_sending(self, request):
        with self.assertRaises(NotificationError):
            send_message("https://example.com/api/webhooks/123/secret", {})
        request.assert_not_called()

    @patch("tools.discord_release.time.sleep")
    @patch("tools.discord_release.urlopen")
    def test_persistent_rate_limits_fail_after_three_attempts(self, request, sleep):
        request.side_effect = [
            HTTPError(WEBHOOK, 429, "rate limit", {}, io.BytesIO(b'{"retry_after":0}'))
            for _ in range(3)
        ]
        with self.assertRaisesRegex(NotificationError, "HTTP 429"):
            send_message(WEBHOOK, {})
        self.assertEqual(request.call_count, 3)

    @patch("tools.discord_release.time.sleep")
    @patch("tools.discord_release.urlopen")
    def test_invalid_rate_limits_fail_without_waiting(self, request, sleep):
        for body in (b"{}", b'{"retry_after":-1}', b'{"retry_after":61}', b"invalid"):
            with self.subTest(body=body):
                request.side_effect = HTTPError(
                    WEBHOOK, 429, "rate limit", {}, io.BytesIO(body)
                )
                with self.assertRaises(NotificationError):
                    send_message(WEBHOOK, {})
                sleep.assert_not_called()


class CommandTests(unittest.TestCase):
    def run_notifier(self, release, *args):
        return subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("discord_release.py")),
                *args,
            ],
            input=json.dumps(release, ensure_ascii=False).encode("utf-8"),
            capture_output=True,
            check=False,
            env={
                key: value
                for key, value in os.environ.items()
                if key != "DISCORD_RELEASE_WEBHOOK_URL"
            },
        )

    def test_preview_preserves_utf8_without_a_webhook(self):
        result = self.run_notifier(RELEASE, "--preview", "--test")
        self.assertEqual(result.returncode, 0, result.stderr)
        (message,) = json.loads(result.stdout)
        self.assertIn("—", message["embeds"][0]["description"])
        self.assertIn("zuverlässig", message["embeds"][0]["description"])

    def test_missing_secret_fails_before_posting(self):
        result = self.run_notifier(RELEASE)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"DISCORD_RELEASE_WEBHOOK_URL is required", result.stderr)

    def test_invalid_release_json_has_a_readable_error(self):
        result = self.run_notifier({})
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"Invalid GitHub release JSON", result.stderr)


if __name__ == "__main__":
    unittest.main()
