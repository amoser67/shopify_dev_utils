const path = require("path");
const base = Object.create(null);
//  These objects are filled with data when data_object_init method is called.
const paths = Object.create(null);
const auth = Object.create(null);

const source_array = {
    "auth": auth,
    "paths": paths
};

//  Each argument should be a name of one of the objects created above, e.g. paths, theme, etc.
const create_data_object = function (...args) {
    if (args.length === 0) {
        return Object.create(null);
    }
//  Get an array of all the source objects we want to assign to the object we return.
    const sources = args.map(
        function (source_name) {
            let obj = Object.create(null);
            obj[source_name] = source_array[source_name];
            return obj;
        }
    );
    return Object.assign(Object.create(null), ...sources);
};

const data_objects_init = function (env_vars) {
    return function init_data_requestor(cb, data) {
        try {
            paths.base = env_vars.base_path;
            paths.scripts = `${paths.base}/scripts`;
            paths.styles = `${paths.base}/styles`;
            paths.theme = `${paths.base}/theme`;
            auth.store_url = env_vars.store_url;
            auth.store_preview_url = env_vars.store_preview_url;
            auth.theme_id = env_vars.theme_id;
            auth.auth = env_vars.auth;
            return cb(data);
        } catch (exception) {
            return cb(null, exception);
        }
    }
}


exports.create_data_object = create_data_object;
exports.data_objects_init = data_objects_init;
