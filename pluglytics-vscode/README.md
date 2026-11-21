# PlugLytics for VS Code

The PlugLytics extension provides quick access to the PlugLytics API dashboard and documentation.

## Commands

Open the Command Palette with `Ctrl+Shift+P`:

- `PlugLytics: Open Dashboard`
- `PlugLytics: Open API Documentation`
- `PlugLytics: Start API`
- `PlugLytics: Check API Health`
- `PlugLytics: Connect Account`
- `PlugLytics: Refresh Available LMS Dates`
- `PlugLytics: Filter Dashboard by Date`

## Configuration

Set `pluglytics.baseUrl` to the PlugLytics server URL. The default is `http://localhost:3000`.
After sign-in, the extension automatically fetches the terms and activity dates permitted for your role. Choose a term or date range from the Command Palette to open the dashboard with `from` and `to` filters.

The access token is kept in VS Code SecretStorage. The password is only used for sign-in and is not saved.

On first activation, the extension offers to connect an account. You can also run **PlugLytics: Connect Account** at any time. To refresh after the initial fetch, run **PlugLytics: Refresh Available LMS Dates**. Choose a date filter with **PlugLytics: Filter Dashboard by Date**.

### LMS compatibility

After PlugLytics sign-in, the extension automatically reads role-scoped dates and terms from `/api/v1/me/filter-options`. To also fetch dates directly from an LMS REST API, run **PlugLytics: Configure LMS Date API** and enter an endpoint returning JSON records with ISO-formatted date fields (or Unix-second timestamps in date-related fields). If the endpoint requires a bearer token, run **PlugLytics: Set LMS API Token**; it is stored in VS Code SecretStorage. The extension requests the configured endpoint on activation and when date filters are refreshed. Use HTTPS for non-local endpoints.

The generic date reader works with JSON APIs, not ordinary LMS web pages, and does not implement each vendor's sign-in, OAuth, pagination, or response conventions. Some institutions will still need a provider adapter or import mapping to bring LMS data into PlugLytics' normalized schema. Filtering PlugLytics analytics only changes the dashboard results when matching LMS data has been imported into PlugLytics. The current demo uses synthetic seeded data.

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
