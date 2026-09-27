import pngToIco from "png-to-ico";

pngToIco(["D:/TorrClient/app/build/iconwork/icon.png"], "D:/TorrClient/app/build/windows/icon.ico")
    .then(() => console.log("ico ok"))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });