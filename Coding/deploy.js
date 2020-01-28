// Modules
const path          = require("path");
const ShopifyAPI    = require("./requestor_factories/api_requests");
const Fs            = require("./requestor_factories/fs_operations");
const { run_sync,
        run_async } = require("./utils");
const log           = require("./log");
const { create_data_object } = require("./create_data_objects");

const base_path = path.dirname(__dirname);
const theme_path = `${base_path}/theme`;


//  Upload all files from the theme directory to the online store who's config is
//  setup in api_requests.js.  If there are files in your store which are not present
//  locally, nothing will be done to them.
(function deploy() {
    try {
        run_sync(
            [
                Fs.get_all_file_paths(theme_path),
                ShopifyAPI.upload_file_array("from data")
            ],
            function (data, reason) {
                if (data === null) throw reason;
                log("Deploy", "complete");
            },
            create_data_object("paths", "auth")
        );
    } catch (exception) {
        log("ERROR: ", exception);
    }
})();
