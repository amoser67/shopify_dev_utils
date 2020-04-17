// Modules
const Path = require("path");
const ShopifyAPI = require("./requestor_factories/api_requests");
const Fs = require("./requestor_factories/fs_operations");
const { log } = require("./log");
const { run_sync, run_async } = require("./utils");
const { create_data_object, data_objects_init } = require("./create_data_objects");

let base_path;
let theme_path;

// @purpose:  Upload local theme files to the store's theme.
// @param1 {array=} filenames - (optional) An array of theme file keys to upload,
//  if this param is undefined, then all theme files will be uploaded.
exports.Deploy = function (env_vars) {
    const readWriteMap = new Map();
    const paths = Object.create(null);
    const data = Object.create(null);

    base_path = env_vars.base_path;
    theme_path = Path.join(base_path, "theme");

    ShopifyAPI.init(env_vars);
    data_objects_init(env_vars)(function (data, reason) {
        if (data === null) throw reason;
    });

    run_sync(
        [
            Fs.get_all_file_paths(theme_path),
            buildMap,
            ShopifyAPI.upload_files(readWriteMap)
        ],
        function (data, reason) {
            if (data === null) throw reason;
            log("Deploy", "complete");
        },
        create_data_object("auth", "paths")
    );


    function buildMap(cb, data) {
        try {
            data.files.forEach(function (filename) {
                const keyPath = filename.replace(theme_path + Path.sep, "");
                const localKey = keyPath.replace(Path.sep, "/");
                let key;

                if (!localKey.includes("templates/customers")) {
                    let arr = localKey.split("/");
                    const newArr = [arr[0], arr[2] || arr[1]];
                    key = newArr.join("/");
                } else {
                    key = localKey;
                }

                readWriteMap.set(filename, key);
            });
            return cb(data);
        } catch (exception) {
            return cb(null, exception);
        }
    }
};
