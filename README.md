# Shopify Development Utilities Project


## README Sections
+ [Purpose of Project][1]

[1]: https://github.com/amoser67/shopify_dev_utils/blob/master/README.md#Features

## Purpose of Project

To provide a stable and customizable development environment for working on Shopify
sites, meant to replace working with a combination of gulp / themekit.


## Features

- Watches your local files, and uploads local changes to your store.

- Creates a local proxy server for the store's webpage.

- Opens your browser on startup, and refreshes the page after each file upload.

- Enables the addition of sub-directories to the theme/snippets, theme/sections,
and theme/template directories, in order to improve project organization.

- Allows the two directories scripts and styles to exist outside the theme, and
watches them for changes.  When changes occur the file's contents are minified and
written to theme/assets file according to the procedure below.


## Overview

Expected Directory Structure:

    project-root
        theme
        scripts
        styles
        node_modules
        package.json
        run.js

## Scripts

The scripts directory can contain files and sub-directories, however these sub-directories
may not contain additional directories. We refer to the files which are in the scripts
directory as *primary* files, and the files which are in the sub-directories as *secondary* files.

We refer to the JS files we add to theme/assets as *modules*. Each module corresponds
to either the minified contents of a *primary* file or the minified and concatenated contents
of all *secondary* files within a sub-directory.  In other words, each sub-directory and *primary*
file in scripts are associated with a *module* of the same name in theme/assets.

## Styles

The styles directory is meant to contain scss files and sub-directories, and
unlike scripts, there is no limit to sub-directory nesting.  However, at this point
modulation of styles is not supported, so there must be a *primary* file in the styles
directory named *main.scss*, and when a change ocurrs in a scss file, *main.scss* will have
its contents compiled to css, minified, and written to theme/assets/main.css.liquid.


## Theme

The theme directory is expected to contain at least the following directories:

- assets
- layout
- locales
- sections
- snippets
- templates
- templates/customers

Theme directories *sections*, *snippets*, and *templates*, are allowed to contain
sub-directories, but these sub-directories cannot contain addition sub-directories.
Although Shopify does not allow *theme* directories to contain sub-directories, with
the exception of *templates/customers*, they can exist locally here because when the
files are uploaded their *key* (denotes file's relative path in *theme*), has the
sub-directory component removed, so the uploaded version of these three *theme* directories
will end up being a flattened version of their local counterparts.


**Setup**

1. Make sure you are using node v13+.

2. $ npm i shopify_dev_utils

3. $ npm i dot-env

4. Create a private app with read/write theme privileges.

5. Create a .env file and place it in project_root.  It should resemble the following:

    AUTH = [private-app-key]:[private-app-pass]
    
    THEME_ID = 1234567891
    
    STORE_URL = test-alpha-bravo.myshopify.com

    Replacing the bracketed values with your private app info, and making sure to add
    your own theme id and store url.  Note, if you are editing an unpublished theme,
    you will need to preview the theme, click the share preview link at the bottom,
    and then add the following property to your .env file:

    STORE_PREVIEW_URL = [the share preview link]

    Additionally, this value will have to be updated every two weeks.

    You can also specify a local port number if their are conflicts with the default 8080.

6. Create a file named run.js in project-root. It should be similar to the following:
    ```javascript
    const path = require("path");
    const dotenv = require("dotenv").config();
    const shopify_dev_utils = require("shopify_dev_utils");
    const data = Object.create(null);

    // Required variables:
    data.store_url = process.env.STORE_URL;
    data.theme_id  = process.env.THEME_ID;
    data.auth      = process.env.AUTH;
    //  Optional variables:
    data.port      = process.env.PORT || 8080;
    data.store_preview_url = process.env.STORE_PREVIEW_URL;

    //  Project Root Directory
    data.base_path = __dirname;

    try {
        shopify_dev_utils.start(data);
    } catch (exception) {
        console.log("ERROR: ", exception);
    }
    ```

7. If you are using a mac, go to project_root/node_modules/shopify_dev_utils,
and then use xcode to compile jsmin.c to mac OS compatible executable named jsmin-darwin.
If someone sends me a copy of this executable file I will add it in to the project
to prevent others from having to do this.

8. $ node run

9. Environment should be setup and running!
