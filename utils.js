"use strict";
const os = require("os");
const { execFile } = require("child_process");

//  Util Public Methods:
//
//      1.  open()
//      2.  run_sync()
//      3.  run_async()
//

//  @param1 {string} url  -  e.g. https://google.com
const open_browser = function (url) {
//  Determine current os in order to choose an applicable binary.
//  "Linux", "Darwin" (mac), or "Windows_NT" expected.
    const os_type = os.type();
    const executable_file = (
        os_type === "Linux" ? "xdg-open"
        : os_type === "Darwin" ? "open"
        : os_type === "Windows_NT" ? "start"
        : undefined
    );
    return function open_browser_requestor(cb, data) {
        try {
            execFile(
                executable_file,
                [ url ],
                function (error, stdout) {
                    if (error) throw error;
                    if (cb) {
                        return cb(data);
                    }
                }
            );
        } catch (exception) {
            return cb(null, exception);
        }
    }
};



//  Run an array of requestors synchronously.
const run_sync = function (requestors, cb, initial_value) {
    let next_number = 0;
    start_requestor(initial_value);
    function start_requestor(value, reason) {
        if (value === null) {
            return cb(null, reason);
        } else if (next_number < requestors.length) {
            const number = next_number;
            next_number += 1;
            const requestor = requestors[number];
            requestor(
                function (value, reason) {
                    return start_requestor(value, reason);
                },
                value
            );
        } else {
            return cb(value);
        }
    }
}

//  Run an array of requestors asynchronously.
const run_async = function (requestors, cb, initial_value, time_limit=false) {
    try {
        let timer;
        if (time_limit) {
            timer = setTimeout(function () {
                requestors = undefined;
                console.log("Error", " run_async instance has exceeded its time limit.");
            }, time_limit);
        }

        let i = 0;
        while (i < requestors.length) {
            const requestor = requestors[i];
            setTimeout(requestor, 0, check_in, initial_value);
            i += 1;
        }

        let num_checked_in = 0;

        function check_in(data, reason) {
            num_checked_in += 1;
            if (data === null) {
                return cb(null, reason);
            }
            if (num_checked_in === requestors.length) {
                if (timer) {
                    clearTimeout(timer);
                }
                return cb();
            }
        }

    } catch(err) {
        console.log(err);
    }
};


exports.open = open_browser;
exports.run_sync = run_sync;
exports.run_async = run_async;
