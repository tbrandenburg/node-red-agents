/**
 * Node-RED runtime settings for the demo instance.
 *
 * This is a separate userDir from data/ (the local dev sandbox) so that
 * `make demo` never touches real, potentially-unsaved dev work in
 * data/flows.json -- see docs/260817_Refactoring.md step 13.
 *
 * Docs: https://nodered.org/docs/user-guide/runtime/settings-file
 */
module.exports = {
    flowFile: 'flows.json',
    flowFilePretty: true,

    // No nodesDir here on purpose -- the demo instance only exercises the
    // published node-red-agents package (installed as a normal dependency
    // below), not data/nodes/'s single-file drop-in nodes.

    // Different port from the dev instance (1880) so both can run at once.
    uiPort: process.env.DEMO_PORT || 1881,

    functionGlobalContext: {
        // Same convention as data/settings.js: derived from this instance's
        // own userDir, so the Chat/Advanced Chat flows' agent nodes (cwd,
        // type "global") can never write outside demo/chat/.
        chatDir: require('path').join(__dirname, 'chat')
    },

    externalModules: {
        autoInstall: false
    },

    editorTheme: {
        theme: "midnight-red",
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
