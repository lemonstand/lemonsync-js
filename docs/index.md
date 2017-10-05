# LemonSync
A tool for syncing local theme files with a live [LemonStand](https://lemonstand.com/) store.

## Installation

To install LemonSync, first install [Node.js](https://nodejs.org/en/). This comes with npm, the package manager for node.js applications. To confirm that you have npm installed you can run this command in your terminal:

```
$ 🍋 npm -v
```

With npm you can now install LemonSync:
```
$ 🍋 [sudo] npm install lemonsync -g
```

### Uninstalling previous versions of LemonSync

If you have the Python version of LemonSync installed, you will need to uninstall it:

```
$ 🍋 sudo pip uninstall lemonsync
```

You can verify that you have LemonSync installed properly by running the following:

```
$ 🍋 which lemonsync
/Users/<youruser>/.npm/bin/lemonsync
```

_Note: You may need to start your terminal application after uninstalling previous versions of LemonSync._


## Usage

1. Download a theme from your [LemonStand](https://lemonstand.com/) store.
2. Create a JSON file, `lemonsync.json` and place it in your theme folder.
3. From within the theme folder, run:


```
$ 🍋  lemonsync
```

### Example `lemonsync.json` configuration

 The LemonSync-js configuration is a JSON file should contain the following:

```
{
  "theme_code": "zest",
  "store": "https://yourstore.lemonstand.com",
  "api_token": "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678910",
  "ignore_patterns": [ "*.tmp", ".git", "lemonsync.json" ]
}
```

Example: [lemonsync.json](https://raw.githubusercontent.com/tomcornall/lemonsync-js/master/lemonsync.json)


## Additional options

| Command Line Option      | Description |
| ------------------------ | ----------- |
| `--reset=local` | Overwrite local theme with store version |
| `--version` | Show the current version of `lemonsync` |
| `--verbose` | Show additional logging detail |
| `--network-logging` | Show detail of each network request |
| `--reset=remote` | Overwrite store theme with local version <br>  **Warning: this option will overwrite your store's remote theme and can delete your remote theme if used incorrectly.** |


