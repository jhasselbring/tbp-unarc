#!/usr/bin/env node

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util'); // Needed for promisify

// ANSI Color Codes
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m", // For warnings
};

// Promisify exec for potential use later if needed
const execPromise = util.promisify(exec);
// Promisify fs.mkdir (note: requires Node v10+)
const mkdirPromise = util.promisify(fs.mkdir);

const currentDir = process.cwd();
const archiveExtensions = ['.zip', '.rar', '.7z'];

// --- Argument Parsing ---
const args = process.argv.slice(2); // Get arguments after 'node' and script name
const isRecursive = args.includes('-r') || args.includes('--recursive');

// --- Recursive File Finding Function ---
const getAllFiles = (dirPath, arrayOfFiles = []) => {
  try {
    const files = fs.readdirSync(dirPath);

    files.forEach(file => {
      const fullPath = path.join(dirPath, file);
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          // Recurse into subdirectories
          getAllFiles(fullPath, arrayOfFiles);
        } else {
          // Add file path to the list
          arrayOfFiles.push(fullPath);
        }
      } catch (statErr) {
        // Use yellow for warnings
        console.warn(`${colors.yellow}Could not access ${fullPath}, skipping. Error: ${statErr.message}${colors.reset}`);
      }
    });
  } catch (readDirErr) {
      // Use yellow for warnings
      console.warn(`${colors.yellow}Could not read directory ${dirPath}, skipping. Error: ${readDirErr.message}${colors.reset}`);
  }
  return arrayOfFiles;
};

console.log(`Scanning ${currentDir}${isRecursive ? ' recursively' : ''} for archives...`);

// Use an async IIFE to allow top-level await
(async () => {
  try {
    // 1. Get list of files (recursive or not)
    let allFilePaths = [];
    if (isRecursive) {
      console.log('Recursive mode enabled.');
      allFilePaths = getAllFiles(currentDir);
    } else {
      // Get full paths for non-recursive mode too, for consistency
      try {
          const filesInCurrentDir = fs.readdirSync(currentDir);
          allFilePaths = filesInCurrentDir.map(f => path.join(currentDir, f));
      } catch (readDirErr) {
          // Use red for critical errors
          console.error(`${colors.red}Error reading directory ${currentDir}: ${readDirErr.message}${colors.reset}`);
          process.exit(1);
      }
    }

    // 2. Filter for supported archive files from the list of paths
    const archives = allFilePaths.filter(filePath => {
      const ext = path.extname(filePath).toLowerCase();
      try {
        // Check if it's a file with the correct extension
        return archiveExtensions.includes(ext) && fs.statSync(filePath).isFile();
      } catch (statErr) {
        // Ignore errors like permission denied, file not found during check
        // (getAllFiles already warns about access errors)
        return false;
      }
    });

    if (archives.length === 0) {
      console.log(`No archive files (${archiveExtensions.join(', ')}) found${isRecursive ? ' in the scanned directories' : ''}.`);
      return;
    }

    console.log(`Found archives:\n  ${archives.join('\n  ')}`); // List full paths

    // 3. Process each archive sequentially
    for (const archivePath of archives) { // Use the full path now
      const archiveFile = path.basename(archivePath); // Get just the filename for logging
      const archiveDir = path.dirname(archivePath); // Get the directory containing the archive
      console.log(`\n--- Processing: ${archivePath} ---`); // Log full path being processed
      const archiveNameBase = path.basename(archiveFile, path.extname(archiveFile));
      // Output directory should be relative to the archive's location
      const outputDir = path.join(archiveDir, archiveNameBase);
      const fileExt = path.extname(archiveFile).toLowerCase();

      // 4. Create the output directory
      try {
        await mkdirPromise(outputDir, { recursive: true });
        console.log(`Directory ensured: ${outputDir}`);
      } catch (mkdirErr) {
         // Check if it failed because the directory already exists - okay
        if (mkdirErr.code !== 'EEXIST') {
            // Use red for directory creation errors
            console.error(`${colors.red}Error creating directory ${outputDir}: ${mkdirErr.message}${colors.reset}`);
            console.log(`Skipping archive ${archiveFile}.`);
            continue; // Skip to the next archive
        } else {
             console.log(`Directory ${outputDir} already exists. Extracting into it.`);
        }
      }

      // 5. Determine extraction method
      let command;
      const quotedArchivePath = `"${archivePath}"`; // Use full path
      const quotedOutputDir = `"${outputDir}"`;
      let is7z = false;

      switch (fileExt) {
        case '.zip':
          command = `unzip -o -q ${quotedArchivePath} -d ${quotedOutputDir}`;
          break;
        case '.rar':
          command = `unrar x -o+ ${quotedArchivePath} ${quotedOutputDir}${path.sep}`;
          break;
        case '.7z':
          command = `7z x ${quotedArchivePath} -o${quotedOutputDir} -y`;
          // is7z = false; // No need for is7z flag anymore
          break;
        default:
          // Use yellow for warnings
          console.warn(`${colors.yellow}Unsupported archive type skipped: ${fileExt}${colors.reset}`);
          continue; // Skip to next archive
      }

      // 6. Execute extraction sequentially using execPromise for all types
      let extractionSuccessful = false; // Flag to track success
      try {
        // No more special 'is7z' check needed here
        console.log(`${colors.yellow}Executing: ${command}${colors.reset}`); // Print command in yellow
        console.log(`Extracting ${archiveFile} to ${outputDir}...`);

        const { stdout, stderr } = await execPromise(command);

        if (stderr) {
           console.warn(`${colors.yellow}Stderr during extraction of ${archiveFile}: ${stderr.trim()}${colors.reset}`); // Make stderr yellow too
        }
        if (stdout) {
            // console.log(`Stdout: ${stdout.trim()}`);
        }
        console.log(`Successfully extracted ${archiveFile} via exec.`);
        extractionSuccessful = true; // Mark as successful

      } catch (error) {
          // --- Apply Red Color to Error Messages ---
          console.error(`\n${colors.red}!!! Failed to extract ${archiveFile} !!!${colors.reset}`);
          if (error.code === 'ENOENT' || error.message.includes('command not found') || (process.platform === 'win32' && error.message.includes('is not recognized'))) {
                 const requiredTool = command.split(' ')[0];
                 console.error(`${colors.red}  -> Make sure the required command-line tool (${requiredTool}) is installed and in your PATH.${colors.reset}`);
          } else {
               // Generic errors (corruption, password, etc.)
               console.error(`${colors.red}  Error details: ${error.message}${colors.reset}`);
               // Also print stderr in red if it exists, as it often has the specific reason
               if (error.stderr) {
                    console.error(`${colors.red}  Stderr: ${error.stderr.trim()}${colors.reset}`);
               }
          }
          // Decide whether to continue with the next file or stop
          // continue; // Uncomment to try next file even if one fails
      }

      // 7. Delete archive if extraction was successful
      if (extractionSuccessful) {
          try {
              console.log(`Attempting to delete original archive: ${archivePath}...`);
              await fsPromises.unlink(archivePath); // <--- Delete the file
              console.log(`Successfully deleted ${archiveFile}.`);
          } catch (deleteError) {
              // Log deletion errors as warnings (yellow)
              console.warn(`${colors.yellow}Could not delete archive ${archiveFile}: ${deleteError.message}${colors.reset}`);
          }
      }
    } // End of for...of loop

    console.log('\n--- All archives processed. ---');

  } catch (error) {
    // Catch errors from initial setup (readdir, filter, etc.)
    console.error(`\n${colors.red}--- An unexpected error occurred: ---${colors.reset}`);
    console.error(`${colors.red}${error}${colors.reset}`); // Print the whole error in red
    process.exit(1);
  }
})(); // Execute the async function 