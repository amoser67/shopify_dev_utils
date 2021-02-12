const colors = require("colors");
//  Changes the default behavior of console.log() to suit the project.
//  @param1 {string} action  -  One of "Uploaded", "Deleted", "Error"
//  @param2 {string} target  -  The name of the file or the exception.
const log = function (action, target) {
    try {
        //  When these options are used in toLocaleString(), it results in the following
        //  format: "12:35:20".
            const options = {
                hourCycle: "h24",
                hour: "numeric",
                minute: "numeric",
                second: "numeric"
            }
            const date = new Date(),
                  time = date.toLocaleString("en-US", options),
                  time_stamp = "[".gray + time.cyan.bold.dim + "]".gray + " -";

            target = (
              target && typeof target === "object"
              ? Object.entries(target)
              : `${target}`.italic
            );

            if (action === "Error") {
                console.log(
                    time_stamp,
                    "The following exception was triggered: ".red.bold + "\n",
                    target
                );
            } else {
                console.log(
                    time_stamp,
                    action.green.bold,
                    (action === "Deleted") ? " --" : "--",
                    target
                );
            }
    } catch (exception) {
        console.log(
            "log error ",
            exception
        );
    }

};

exports.log = log;
