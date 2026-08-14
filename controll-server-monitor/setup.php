<?php
declare(strict_types=1);

require __DIR__ . '/includes/db.php';

$error = null;
$edit = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = (string) ($_POST['csm_action'] ?? '');

    if ($action === 'add' || $action === 'update') {
        $label = trim((string) ($_POST['label'] ?? ''));
        $endpointUrl = trim((string) ($_POST['endpoint_url'] ?? ''));
        $apiKey = trim((string) ($_POST['api_key'] ?? ''));

        if ($label === '' || $endpointUrl === '' || $apiKey === '') {
            $error = 'All fields are required.';
        } elseif (filter_var($endpointUrl, FILTER_VALIDATE_URL) === false) {
            $error = 'Endpoint URL is not a valid URL.';
        } else {
            if ($action === 'add') {
                csm_add_site($label, $endpointUrl, $apiKey);
                header('Location: setup.php?saved=1');
            } else {
                $id = (int) ($_POST['id'] ?? 0);
                csm_update_site($id, $label, $endpointUrl, $apiKey);
                header('Location: setup.php?saved=1');
            }
            exit;
        }
    } elseif ($action === 'delete') {
        $id = (int) ($_POST['id'] ?? 0);
        csm_delete_site($id);
        header('Location: setup.php?deleted=1');
        exit;
    }
}

if (isset($_GET['edit'])) {
    $edit = csm_get_site((int) $_GET['edit']);
}

$sites = csm_list_sites();
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup — Controll Server Monitor</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<nav class="csm-nav">
    <span class="csm-nav-brand">Controll Server Monitor</span>
    <a href="index.php">Dashboard</a>
    <a href="setup.php" class="is-active">Setup</a>
</nav>

<div class="csm-main">
    <h2>Registered Sites</h2>
    <p class="csm-description">
        Add each WordPress site running the Controll Server Connection Speed Test plugin. Copy the Endpoint URL and API Key
        from that plugin's "Remote Monitoring API" panel (Server Speed Test admin page &rarr; scroll to the bottom).
    </p>

    <?php if (isset($_GET['saved'])): ?>
        <div class="csm-notice">Site saved.</div>
    <?php elseif (isset($_GET['deleted'])): ?>
        <div class="csm-notice">Site removed.</div>
    <?php endif; ?>

    <?php if ($error !== null): ?>
        <div class="csm-error"><?php echo htmlspecialchars($error); ?></div>
    <?php endif; ?>

    <div class="csm-panel">
        <h3><?php echo $edit !== null ? 'Edit Site' : 'Add a Site'; ?></h3>
        <form method="post" id="csm-site-form">
            <input type="hidden" name="csm_action" value="<?php echo $edit !== null ? 'update' : 'add'; ?>">
            <?php if ($edit !== null): ?>
                <input type="hidden" name="id" value="<?php echo (int) $edit['id']; ?>">
            <?php endif; ?>
            <div class="csm-form-row">
                <div class="csm-field">
                    <label for="csm-label">Label</label>
                    <input class="csm-input" type="text" id="csm-label" name="label" placeholder="e.g. Goldplat"
                        value="<?php echo htmlspecialchars($edit['label'] ?? ''); ?>" required>
                </div>
                <div class="csm-field">
                    <label for="csm-endpoint">Endpoint URL</label>
                    <input class="csm-input" type="url" id="csm-endpoint" name="endpoint_url"
                        placeholder="https://example.com/wp-json/csst/v1/stats"
                        value="<?php echo htmlspecialchars($edit['endpoint_url'] ?? ''); ?>" required>
                </div>
                <div class="csm-field">
                    <label for="csm-apikey">API Key</label>
                    <input class="csm-input" type="text" id="csm-apikey" name="api_key"
                        value="<?php echo htmlspecialchars($edit['api_key'] ?? ''); ?>" required>
                </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <button type="submit" class="csm-btn csm-btn-primary"><?php echo $edit !== null ? 'Save Changes' : 'Add Site'; ?></button>
                <button type="button" id="csm-test-btn" class="csm-btn">Test Connection</button>
                <?php if ($edit !== null): ?>
                    <a href="setup.php" class="csm-btn">Cancel</a>
                <?php endif; ?>
                <span id="csm-test-result" class="csm-poll-status"></span>
            </div>
        </form>
    </div>

    <div class="csm-panel">
        <h3>Sites (<?php echo count($sites); ?>)</h3>
        <?php if (empty($sites)): ?>
            <p class="csm-empty">No sites registered yet. Add one above.</p>
        <?php else: ?>
            <div style="overflow-x:auto">
                <table class="csm-table">
                    <thead>
                        <tr>
                            <th>Label</th>
                            <th>Endpoint URL</th>
                            <th>Added</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($sites as $site): ?>
                            <tr>
                                <td><?php echo htmlspecialchars($site['label']); ?></td>
                                <td style="font-family:ui-monospace,monospace;font-size:12px"><?php echo htmlspecialchars($site['endpoint_url']); ?></td>
                                <td><?php echo htmlspecialchars($site['created_at']); ?></td>
                                <td style="text-align:right;white-space:nowrap">
                                    <span class="csm-row-test-result" id="csm-row-test-result-<?php echo (int) $site['id']; ?>"></span>
                                    <button type="button" class="csm-btn csm-row-test-btn" data-id="<?php echo (int) $site['id']; ?>">Test Connection</button>
                                    <a class="csm-btn" href="setup.php?edit=<?php echo (int) $site['id']; ?>">Edit</a>
                                    <form method="post" style="display:inline" onsubmit="return confirm('Remove this site from monitoring?');">
                                        <input type="hidden" name="csm_action" value="delete">
                                        <input type="hidden" name="id" value="<?php echo (int) $site['id']; ?>">
                                        <button type="submit" class="csm-btn csm-btn-danger">Delete</button>
                                    </form>
                                </td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            </div>
        <?php endif; ?>
    </div>
</div>

<script src="assets/setup.js"></script>
</body>
</html>
