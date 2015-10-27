
module.exports = function (grunt) {
  grunt.initConfig({
    zip: {
      'instaPhotos.zip': ['index.js', 'node_modules/async/**', 'node_modules/gm/**']
    }
  });

  grunt.loadNpmTasks('grunt-zip');
};
