# Ximalaya for MyGo Music

A [MyGo Music](https://github.com/egoist/mygo-music) plugin for browsing and playing Ximalaya content, with search and QR-code sign-in.

## Warning / 警告

**English:** This plugin is provided for technical study and research only. Delete it within 24 hours of downloading it. Any consequences arising from its use are the user's responsibility; the author assumes no legal liability.

**中文：** 本插件仅供技术学习和研究使用，请在下载后 24 小时内删除。使用本插件产生的任何后果由使用者自行承担，作者不承担任何法律责任。

## Features

- Browse recommendations, the membership section, charts, and categories.
- Search for audio tracks and albums. Albums open as podcasts in MyGo, with paginated episode lists.
- View listening history, subscriptions, and followed updates.
- Subscribe to or unsubscribe from an album on its detail page. Changes sync with your Ximalaya account.
- Sign in by scanning a QR code with the Ximalaya app. The confirmation identifies the session as Ximalaya for desktop.
- Play free audio and content available to your account in standard or high-quality MP3.

The plugin's navigation labels are currently in Chinese. They lead to Discover, Membership, Charts, Categories, Listening History, My Subscriptions, and Followed Updates.

## Installation

Requires **MyGo Music 0.1.20 or later**.

[Install the Ximalaya plugin](mygo-music://install-plugin?repo=LANMIN-X/mygo-plugin-ximalaya)

Installation URL: `mygo-music://install-plugin?repo=LANMIN-X/mygo-plugin-ximalaya`

Alternatively:

1. In MyGo Music, open **Settings → Plugins → +**.
2. Choose GitHub installation and enter `LANMIN-X/mygo-plugin-ximalaya` or this repository's URL.
3. Review the requested permissions, install the plugin, and switch to the Ximalaya source.
4. To access membership content and personal data, open the account menu and scan the QR code with the Ximalaya app.

You can also install a ZIP from your computer or copy the directory containing `plugin.json` and `index.js` into MyGo Music's plugins folder. The plugin is bundled into a single file; Node.js is not required to install or use it.

## Usage

- In search, use **Songs** for audio tracks and **Podcasts** for Ximalaya albums.
- **My Subscriptions** lists subscribed albums. MyGo caches this page, so changes may take about 30 seconds to appear after reopening it.
- **Followed Updates** lists new episodes from followed albums. Changing follow settings and syncing playback progress back to Ximalaya are not supported.
- Access to paid, membership, and limited-time free content depends on your Ximalaya account's current permissions.
- Standard and high-quality MP3 are available; lossless audio is not supported.

## Subtitles

The plugin can retrieve timestamped transcripts provided by Ximalaya. MyGo currently treats album episodes as podcasts, and its podcast view does not display lyrics returned by plugins. A transcript may therefore be unavailable in the interface even when Ximalaya provides one. Displaying it requires support in MyGo itself. Episodes without a transcript have no subtitles.

## Third-party licenses

See [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt) for the third-party components used by this plugin and their licenses.

This is an independently developed MyGo Music plugin and is not affiliated with Ximalaya. It relies on existing service interfaces, so service or access-control changes may affect its operation.
