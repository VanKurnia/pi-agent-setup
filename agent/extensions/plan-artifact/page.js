/** @preserve */
var token = new URLSearchParams(window.location.search).get("token") || "";
var pendingCommentSection = -1;
var currentPlan = null;
var renderedSections = new Set();

function esc(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function copyCode(btn) {
  var code = btn.closest(".code-block").querySelector("code");
  var lines = code.querySelectorAll(".line");
  var text = "";
  for (var i = 0; i < lines.length; i++) {
    text += lines[i].textContent + "\n";
  }
  navigator.clipboard.writeText(text.trim()).then(function () {
    btn.classList.add("copied");
    setTimeout(function () { btn.classList.remove("copied"); }, 1500);
  });
}

var pollingActive = true;
var disconnectReason = "";

var ICON_ACCEPT =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
var ICON_CHECK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
var ICON_COMMENT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
var ICON_COPY =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var ICON_REJECT =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
var ICON_EDIT =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
var ICON_DELETE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

function showSkeleton() {
  document.getElementById("content").innerHTML =
    '<div class="skeleton" aria-label="Loading plan…">' +
    '<div class="skeleton-line" style="width:60%"></div>' +
    '<div class="skeleton-line" style="width:90%"></div>' +
    '<div class="skeleton-line" style="width:75%"></div>' +
    '<div class="skeleton-line" style="width:40%"></div>' +
    '</div>';
}

function highlightCodeBlocks(root) {
  if (!window.hljs) return;
  root.querySelectorAll('.code-block code').forEach(function (codeEl) {
    if (codeEl.dataset.highlighted) return;
    var langClass = Array.from(codeEl.classList).find(function (c) { return c.startsWith('language-'); });
    var lang = langClass ? langClass.replace('language-', '') : null;
    var raw = codeEl.textContent;
    var tmp = document.createElement('code');
    if (lang) tmp.className = 'language-' + lang;
    tmp.textContent = raw;
    hljs.highlightElement(tmp);
    codeEl.innerHTML = tmp.innerHTML.split('\n').map(function (l) {
      return '<span class="line">' + (l || ' ') + '</span>';
    }).join('\n');
    codeEl.dataset.highlighted = '1';
  });
  // legacy <pre><code> not inside .code-block
  root.querySelectorAll('pre:not(.mermaid):not(.code-block pre)').forEach(function (el) {
    if (el.dataset.highlighted) return;
    hljs.highlightElement(el);
    el.dataset.highlighted = '1';
  });
}

function runMermaid(root) {
  if (!window.mermaid) return;
  var diagrams = root.querySelectorAll('pre.mermaid:not([data-rendered])');
  if (diagrams.length === 0) return;
  diagrams.forEach(function (el) { el.dataset.rendered = '1'; });
  window.mermaid.run({ querySelector: 'pre.mermaid[data-rendered="1"]' }).catch(function () {});
}

function loadPlan() {
  if (!pollingActive) return;
  fetch("/api/plan?token=" + token)
    .then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    })
    .then(function (p) {
      if (!p) {
        document.getElementById("content").innerHTML = "<p class='muted'>No plan.</p>";
        return;
      }
      currentPlan = p;
      document.getElementById("summary").textContent = p.summary;
      var badge = document.getElementById("statusBadge");
      badge.textContent = p.status.charAt(0).toUpperCase() + p.status.slice(1);
      badge.className = "status-badge " + p.status;
      document.getElementById("acceptBtn").disabled = p.status === "accepted";
      document.getElementById("rejectBtn").disabled = p.status !== "pending";
      disconnectReason = "";

      var html = renderSections(p);
      var contentEl = document.getElementById("content");
      contentEl.innerHTML = html;
      highlightCodeBlocks(contentEl);
      runMermaid(contentEl);
    })
    .catch(function () {
      pollingActive = false;
      // preserve last rendered plan but show disconnect banner
      var banner = document.getElementById("disconnect");
      if (!banner) {
        var msg = disconnectReason ? "Plan " + disconnectReason : "Disconnected — server stopped.";
        document.getElementById("content").insertAdjacentHTML("afterbegin",
          '<div class="disconnect-banner" id="disconnect">' + msg + '</div>'
        );
      }
    });
}

function renderSections(p) {
  var html = "";
  for (var i = 0; i < p.sections.length; i++) {
    var s = p.sections[i];
    var tag = "h" + Math.min(s.level, 6);
    if (i > 0) html += '<hr class="section-sep" role="separator">';
    html += '<div class="section">';
    html += '<div class="section-header">';
    html += "<" + tag + ">" + esc(s.title) + "</" + tag + ">";
    html +=
      '<button class="comment-btn" data-section-index="' +
      i +
      '" title="Add comment" aria-label="Add comment on ' + esc(s.title) + '">' +
      ICON_COMMENT +
      "</button>";
    html += "</div>";
    html += "<div>" + s.content + "</div>";
    if (p.comments) {
      html += '<div class="comments">';
      for (var j = 0; j < p.comments.length; j++) {
        if (p.comments[j].sectionIndex === i) {
          var cid = p.comments[j].id;
          html += '<div class="comment" data-comment-id="' + esc(cid) + '" data-section-index="' + i + '">';
          html += '<span class="comment-text">' + esc(p.comments[j].text) + '</span>';
          html += '<span class="comment-actions">';
          html += '<button class="comment-action-btn edit-btn" data-comment-id="' + esc(cid) + '" title="Edit comment" aria-label="Edit comment">' + ICON_EDIT + '</button>';
          html += '<button class="comment-action-btn delete-btn" data-comment-id="' + esc(cid) + '" title="Delete comment" aria-label="Delete comment">' + ICON_DELETE + '</button>';
          html += '</span>';
          html += '</div>';
        }
      }
      html += "</div>";
    }
    html += "</div>";
  }
  return html;
}

setInterval(loadPlan, 3000);
loadPlan();

document.getElementById("acceptBtn").addEventListener("click", acceptPlan);
document.getElementById("rejectBtn").addEventListener("click", requestChanges);
document.getElementById("cancelBtn").addEventListener("click", closeCommentModal);
document.getElementById("submitBtn").addEventListener("click", submitCommentModal);

// ── event delegation on content (handles dynamic sections) ──
document.getElementById("content").addEventListener("click", function (e) {
  var editBtn = e.target.closest(".edit-btn");
  if (editBtn && editBtn.dataset.commentId !== undefined) {
    editComment(editBtn.dataset.commentId, parseInt(editBtn.closest(".comment").dataset.sectionIndex));
    return;
  }
  var delBtn = e.target.closest(".delete-btn");
  if (delBtn && delBtn.dataset.commentId !== undefined) {
    deleteComment(delBtn.dataset.commentId);
    return;
  }
  var btn = e.target.closest(".comment-btn");
  if (btn && btn.dataset.sectionIndex !== undefined) {
    addComment(parseInt(btn.dataset.sectionIndex));
  }
});

function acceptPlan() {
  fetch("/api/proposal/accept?token=" + token, { method: "POST" }).then(
    function (r) {
      if (r.ok) { showToast("Plan accepted"); disconnectReason = "accepted"; }
      else showToast("Failed to accept", true);
    }
  );
}

function requestChanges() {
  openCommentModal("Plan Review Feedback", -1, function (text) {
    fetch("/api/proposal/review?token=" + token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: text }),
    }).then(function (r) {
      if (r.ok) { showToast("Feedback sent"); disconnectReason = "changes requested"; }
      else showToast("Failed to send", true);
    });
  });
}

function showToast(msg, isError) {
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.style.display = "block";
  setTimeout(function () { t.style.display = "none"; }, 3000);
}

function addComment(sectionIndex) {
  openCommentModal("Add Comment", sectionIndex, function (text) {
    fetch("/api/proposal/comment?token=" + token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sectionIndex: sectionIndex, text: text }),
    }).then(function (r) {
      if (r.ok) { showToast("Comment added"); loadPlan(); }
      else showToast("Failed to add comment", true);
    });
  });
}

function editComment(commentId, sectionIndex) {
  var comment = currentPlan && currentPlan.comments
    ? currentPlan.comments.find(function (c) { return c.id === commentId; })
    : null;
  openCommentModal("Edit Comment", sectionIndex, function (text) {
    fetch("/api/proposal/comment/edit?token=" + token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: commentId, text: text }),
    }).then(function (r) {
      if (r.ok) { showToast("Comment updated"); loadPlan(); }
      else showToast("Failed to update", true);
    });
  }, comment ? comment.text : "");
}

function deleteComment(commentId) {
  if (!confirm("Delete this comment?")) return;
  fetch("/api/proposal/comment/delete?token=" + token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: commentId }),
  }).then(function (r) {
    if (r.ok) { showToast("Comment deleted"); loadPlan(); }
    else showToast("Failed to delete", true);
  });
}

// ── modal + focus trap ──

var focusTrapElements = [];
function openCommentModal(title, sectionIndex, onSubmit, initialText) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalText").value = initialText || "";
  pendingCommentSection = sectionIndex;
  window._commentOnSubmit = onSubmit;
  document.getElementById("commentModal").classList.add("show");
  document.getElementById("modalText").focus();

  // focus trap
  focusTrapElements = [
    document.getElementById("modalText"),
    document.getElementById("submitBtn"),
    document.getElementById("cancelBtn"),
  ];
  document.addEventListener("keydown", focusTrapHandler);
}

function closeCommentModal() {
  document.getElementById("commentModal").classList.remove("show");
  document.removeEventListener("keydown", focusTrapHandler);
  focusTrapElements = [];
}

function focusTrapHandler(e) {
  if (e.key !== "Tab" || focusTrapElements.length === 0) return;
  var first = focusTrapElements[0];
  var last = focusTrapElements[focusTrapElements.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function submitCommentModal() {
  var text = document.getElementById("modalText").value.trim();
  if (!text) return;
  if (window._commentOnSubmit) window._commentOnSubmit(text);
  closeCommentModal();
}
