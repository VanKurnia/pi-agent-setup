/** @preserve */
var token = new URLSearchParams(window.location.search).get("token") || "";
var pendingCommentSection = -1;
var currentPlan = null;

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

var ICON_ACCEPT =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
var ICON_CHECK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
var ICON_COMMENT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
var ICON_COPY =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var ICON_REJECT =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
var ICON_EDIT =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
var ICON_DELETE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

function loadPlan() {
  if (!pollingActive) return;
  fetch("/api/plan?token=" + token)
    .then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    })
    .then(function (p) {
      if (!p) {
        document.getElementById("sections").innerHTML = "<p>No plan.</p>";
        return;
      }
      currentPlan = p;
      document.getElementById("summary").textContent = p.summary;
      document.getElementById("statusBadge").textContent =
        p.status.charAt(0).toUpperCase() + p.status.slice(1);
      document.getElementById("acceptBtn").disabled = p.status === "accepted";
      document.getElementById("rejectBtn").disabled = p.status !== "pending";

      var html = "";
      for (var i = 0; i < p.sections.length; i++) {
        var s = p.sections[i];
        var tag = "h" + Math.min(s.level, 6);
        html += '<div class="section">';
        html += '<div class="section-header">';
        html += "<" + tag + ">" + esc(s.title) + "</" + tag + ">";
        html +=
          '<button class="comment-btn" data-section-index="' +
          i +
          '" title="Add comment">' +
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
              html += '<button class="comment-action-btn edit-btn" data-comment-id="' + esc(cid) + '" title="Edit comment">' + ICON_EDIT + '</button>';
              html += '<button class="comment-action-btn delete-btn" data-comment-id="' + esc(cid) + '" title="Delete comment">' + ICON_DELETE + '</button>';
              html += '</span>';
              html += '</div>';
            }
          }
          html += "</div>";
        }
        html += "</div>";
      }
      document.getElementById("sections").innerHTML = html;
      // Re-run syntax highlighting and mermaid rendering on new content
      if (window.hljs) window.hljs.highlightAll();
      if (window.mermaid) window.mermaid.run({ querySelector: "pre.mermaid" }).catch(function(){});
    })
    .catch(function () {
      pollingActive = false;
      document.getElementById("sections").innerHTML =
        "<p>Disconnected — server stopped.</p>";
    });
}

setInterval(loadPlan, 3000);
loadPlan();

document.getElementById("acceptBtn").addEventListener("click", acceptPlan);
document.getElementById("rejectBtn").addEventListener("click", requestChanges);
document.getElementById("cancelBtn").addEventListener("click", closeCommentModal);
document.getElementById("submitBtn").addEventListener("click", submitCommentModal);
document.getElementById("sections").addEventListener("click", function (e) {
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
      if (r.ok) showToast("Plan accepted");
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
      if (r.ok) showToast("Feedback sent");
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

function openCommentModal(title, sectionIndex, onSubmit, initialText) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalText").value = initialText || "";
  pendingCommentSection = sectionIndex;
  window._commentOnSubmit = onSubmit;
  document.getElementById("commentModal").classList.add("show");
}

function closeCommentModal() {
  document.getElementById("commentModal").classList.remove("show");
}

function submitCommentModal() {
  var text = document.getElementById("modalText").value.trim();
  if (!text) return;
  if (window._commentOnSubmit) window._commentOnSubmit(text);
  closeCommentModal();
}
