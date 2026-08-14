/**
 * Node-RED runtime settings for this project.
 *
 * This is a trimmed-down settings.js. The full, heavily-commented
 * template shipped with Node-RED lives at:
 *   node_modules/node-red/settings.js
 * Copy any option you need from there into this file.
 *
 * Docs: https://nodered.org/docs/user-guide/runtime/settings-file
 */
module.exports = {
    // Where flows/credentials/nodes for this project are stored.
    // (Set to this directory itself since we launch with --userDir ./data)
    flowFile: 'flows.json',
    flowFilePretty: true,

    // Used to encrypt credentials stored in flows_cred.json.
    // Set this to a fixed random string for real deployments,
    // otherwise Node-RED generates one on first run and stores it
    // in .config.runtime.json next to this file.
    // credentialSecret: "replace-with-a-real-secret",

    // Node-RED automatically scans this folder (relative to userDir)
    // for single-file custom nodes (a .js + optional .html pair).
    // This is the fastest way to develop a new node: drop files here,
    // restart (or `make dev` for auto-restart), and it shows up in
    // the palette. See data/nodes/README.md for details.
    nodesDir: 'nodes',

    // Port the editor/runtime listens on.
    uiPort: process.env.PORT || 1880,

    // Make some extra modules available inside Function nodes via
    // global.get(...), if you need them.
    functionGlobalContext: {
        // os: require('os'),

        // Absolute path to *this* running instance's own "chat" sandbox
        // directory. __dirname here is this instance's userDir (this file
        // lives at <userDir>/settings.js), so this is always derived from
        // wherever this instance's data/ actually is -- never a hardcoded
        // path, and never wherever the node-red process happened to be
        // launched from (which, left unset, is what an agent node's cwd
        // falls back to). Used by the Chat flow's agent node (cwd, type
        // "global") so it can never write outside data/chat/.
        chatDir: require('path').join(__dirname, 'chat')
    },

    // Let users add extra npm modules to Function nodes from the editor.
    externalModules: {
        autoInstall: false
    },

    editorTheme: {
        // Provided by @node-red-contrib-themes/theme-collection
        // (installed as a normal npm dependency in this userDir).
        theme: "midnight-red",

        // Flip on to enable Node-RED's built-in git-backed "Projects"
        // feature (separate from the custom-node workflow below).
        projects: {
            enabled: false
        }
    },

    logging: {
        console: {
            level: 'info',
            metrics: false,
            audit: false
        }
    }
};
