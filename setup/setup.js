// The setup screen: the Jarvis address and an optional Cloudflare Access token (src/setup-preload.ts).
const $ = (id) => document.getElementById(id);
const said = (text, bad = false) => {
  $("said").textContent = text;
  $("said").classList.toggle("bad", bad);
};

let hasSecret = false;

window.setup.get().then((v) => {
  $("address").value = v.address;
  $("accessId").value = v.accessId;
  hasSecret = v.hasSecret;
  $("kept").hidden = !hasSecret;
  if (v.accessId) $("access").open = true;
  if (v.problem) {
    $("problem").textContent = v.problem;
    $("problem").hidden = false;
    $("retry").hidden = false;
  }
  $("address").focus();
});

$("retry").addEventListener("click", () => void window.setup.retry());

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const accessId = $("accessId").value.trim();
  const accessSecret = $("accessSecret").value;
  if (accessId && !accessSecret && !hasSecret) return said("Type the client secret too, or clear the Client ID.", true);
  $("open").disabled = true;
  said("Opening…");
  const why = await window.setup.save({
    address: $("address").value,
    accessId,
    accessSecret,
    keepSecret: !!accessId && !accessSecret && hasSecret,
  });
  $("open").disabled = false;
  if (why) said(why, true);
});
