"use strict";
/**
 * Show the last run's log from garmin-to-ssi. Add as a separate Scriptable
 * script named "view-log" and run it after a run that froze or misbehaved.
 */
const fm = FileManager.local();
const path = fm.joinPath(fm.documentsDirectory(), "garmin-to-ssi.log");
if (!fm.fileExists(path)) {
  QuickLook.present("no garmin-to-ssi.log yet - run garmin-to-ssi at least once");
} else {
  const text = fm.readString(path);
  console.log(text);
  QuickLook.present(text);
  Pasteboard.copy(text); // so you can paste it somewhere
}
Script.complete();
