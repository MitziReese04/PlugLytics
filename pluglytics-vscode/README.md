# PlugLytics for VS Code

The PlugLytics extension provides quick access to the PlugLytics API dashboard and documentation.

## Commands

Open the Command Palette with `Ctrl+Shift+P`:

- `PlugLytics: Open Dashboard`
- `PlugLytics: Open API Documentation`
- `PlugLytics: Start API`
- `PlugLytics: Check API Health`

## Configuration

Set `pluglytics.baseUrl` to the PlugLytics server URL. The default is `http://localhost:3000`.

## Development

1. Open this repository in VS Code.
2. Run `npm run dev` in the repository root.
3. In VS Code, press `F5` and choose **Debug PlugLytics API**.
4. Open `pluglytics-vscode` and press `F5` to launch the extension development host.

Build the installable VSIX:

```bash
cd pluglytics-vscode
npm install
npm run package
code --install-extension pluglytics-0.1.0.vsix
```
