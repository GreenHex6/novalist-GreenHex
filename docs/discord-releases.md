# Discord release announcements

The desktop release workflow calls `discord-release.yml` after its GitHub release
job succeeds. Only stable tags are announced; prereleases, iOS-only tags and
manual build dry runs are excluded. The notifier reads the published GitHub
release body, including any generated notes and download guidance.

Set the repository Actions secret `DISCORD_RELEASE_WEBHOOK_URL` to the Discord
channel's webhook URL. The URL is read only from the environment and must never
be put into a workflow, command argument, or tracked file. To switch channels,
move the webhook in Discord or replace this secret.

Announcements use the Novalist icon and gold accent, the version as their title,
the complete release notes, and two buttons: **Go to releases** opens GitHub's
latest stable release; **Download current release** opens the website's download
chooser at `https://novalist.eu/#copy`, which detects the visitor's operating
system and lets them choose an architecture before downloading. A Discord webhook
cannot detect a reader's system itself. Discord controls link-button colors;
the announcement retains Novalist's gold accent. Long notes
are split into embeds and, if necessary, multiple messages within Discord's
limits. Mentions are disabled.

## Test the appearance

In GitHub Actions, run **Announce release on Discord**. Leave **tag** blank to use
the latest stable release, or enter an existing stable tag. This sends a message
marked **Test preview** to the configured channel without building or publishing
a release. Test previews suppress push and desktop notifications. Point the
webhook at the mod channel while testing.

To inspect payloads locally without posting or needing the webhook secret:

```bash
gh api repos/Drommedhar/novalist-official/releases/latest | python tools/discord_release.py --preview --test
```

## Delivery and retries

Discord must confirm delivery before the job succeeds. Rate limits are retried
up to twice using Discord's retry delay; other errors fail the notification job.
The published release and downloads remain available if notification fails.
Use **Re-run failed jobs** to retry the notification without rebuilding the app.

Each run posts new messages. Check the channel before retrying after an uncertain
delivery or partial multi-message delivery, and avoid **Re-run all jobs** merely
to retry a notification. Successful announcements are not deduplicated across
separate runs. Disable the old MonitoRSS feed when switching to this workflow to
avoid duplicate announcements.
