// Permission-free native self-capture (session 7, Part 1).
//
// WKWebView's takeSnapshotWithConfiguration captures the webview's ACTUAL
// rendered pixels — including GPU-accelerated <canvas> layers — with no macOS
// Screen Recording permission, because an app may snapshot its own content.
// This is the root fix for the verification gap: every session before this one
// could only inspect the dev-server page or logs, never what the native window
// really displayed. (Full-window/other-window capture still requires the user
// to grant Screen Recording to the capturing tool; documented in README.)

#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_app_kit::NSImage;
use objc2_foundation::{NSError, NSRect};

pub fn snapshot_webview(
    window: &tauri::WebviewWindow,
    out_path: PathBuf,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

    let out_for_block = out_path.clone();
    window
        .with_webview(move |webview| {
            // SAFETY: on macOS `inner()` is a WKWebView*. We call the documented
            // async snapshot API and marshal the result through a channel.
            unsafe {
                let wk: *mut AnyObject = webview.inner().cast();
                let tx2 = tx.clone();
                let handler = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
                    let result = (|| -> Result<Vec<u8>, String> {
                        if img.is_null() {
                            let desc = if err.is_null() {
                                "snapshot returned nil image".to_string()
                            } else {
                                (*err).localizedDescription().to_string()
                            };
                            return Err(desc);
                        }
                        nsimage_to_png(&*img)
                    })();
                    let _ = tx2.send(result);
                });
                let _: () = msg_send![
                    wk,
                    takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(),
                    completionHandler: &*handler
                ];
                // keep block alive until WebKit fires it
                std::mem::forget(handler);
                let _ = out_for_block; // silence move pedantry
            }
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    let png = rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "snapshot timed out (webview busy or window gone?)".to_string())??;
    if let Some(dir) = out_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&out_path, png).map_err(|e| e.to_string())?;
    Ok(out_path.to_string_lossy().into_owned())
}

// NSImage → PNG bytes via NSBitmapImageRep (AppKit does the encoding).
unsafe fn nsimage_to_png(img: &NSImage) -> Result<Vec<u8>, String> {
    let mut rect = NSRect::new(
        objc2_foundation::NSPoint::new(0.0, 0.0),
        img.size(),
    );
    let cg: *mut AnyObject = msg_send![
        img,
        CGImageForProposedRect: &mut rect,
        context: std::ptr::null::<AnyObject>(),
        hints: std::ptr::null::<AnyObject>()
    ];
    if cg.is_null() {
        return Err("CGImageForProposedRect returned nil".into());
    }
    let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
    let rep: *mut AnyObject = msg_send![rep, initWithCGImage: cg];
    if rep.is_null() {
        return Err("NSBitmapImageRep init failed".into());
    }
    let rep: Retained<AnyObject> = Retained::from_raw(rep).ok_or("rep retain failed")?;
    // NSBitmapImageFileTypePNG = 4
    let data: *mut AnyObject = msg_send![
        &*rep,
        representationUsingType: 4usize,
        properties: std::ptr::null::<AnyObject>()
    ];
    if data.is_null() {
        return Err("PNG representation failed".into());
    }
    let len: usize = msg_send![data, length];
    let bytes: *const u8 = msg_send![data, bytes];
    if bytes.is_null() || len == 0 {
        return Err("empty PNG data".into());
    }
    Ok(std::slice::from_raw_parts(bytes, len).to_vec())
}
