const fs = require("fs");
const path = require("path");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif"]);
const BASE_DIR = __dirname;

function findCatFolders() {
  var folders = [];
  var entries = fs.readdirSync(BASE_DIR);
  entries.sort();
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i];
    if (name === "cats" || /^cats\d+$/.test(name)) {
      var full = path.join(BASE_DIR, name);
      if (fs.statSync(full).isDirectory()) {
        folders.push(name);
      }
    }
  }
  return folders;
}

function scanFolder(folderName) {
  var dirPath = path.join(BASE_DIR, folderName);
  var results = [];

  function walk(dir, rel) {
    var entries = fs.readdirSync(dir);
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i];
      var full = path.join(dir, name);
      var stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, rel ? rel + "/" + name : name);
      } else if (stat.isFile()) {
        var ext = path.extname(name).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          var relative = folderName + "/" + (rel ? rel + "/" : "") + name;
          results.push(relative);
        }
      }
    }
  }

  walk(dirPath, "");
  return results;
}

function build() {
  var folders = findCatFolders();

  if (folders.length === 0) {
    console.log("No cat folders found. Create a 'cats/' folder with images.");
    console.log("Supported folders: cats, cats1, cats2, cats3, ...");
    var manifest = { folders: [], images: [], generatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(BASE_DIR, "cats-manifest.json"), JSON.stringify(manifest, null, 2));
    console.log("Empty manifest written.");
    return;
  }

  console.log("Found folders: " + folders.join(", "));

  var allImages = [];
  for (var i = 0; i < folders.length; i++) {
    var images = scanFolder(folders[i]);
    console.log("  " + folders[i] + "/: " + images.length + " images");
    allImages = allImages.concat(images);
  }

  var manifest = {
    folders: folders,
    images: allImages,
    generatedAt: new Date().toISOString()
  };

  var outPath = path.join(BASE_DIR, "cats-manifest.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log("Manifest written: " + allImages.length + " total images -> cats-manifest.json");
}

build();
