const pngToIco = require("png-to-ico");
pngToIco([__dirname + "\\icon.png"], "D:\\TorrClient\\app\\build\\windows\\icon.ico")
    .then(() => console.log("ico written"))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });