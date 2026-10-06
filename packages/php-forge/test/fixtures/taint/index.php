<?php
include 'lib/db.php';

$id = $_GET['id'];
$sql = "SELECT * FROM clients WHERE id = " . $id;
query($sql); // expect: security-sql-injection

$nom = escape($_POST['nom']);
query("UPDATE clients SET nom = '" . $nom . "' WHERE id = " . (int)$_POST['id']);

echo htmlspecialchars($_GET['q']);
echo $_GET['q']; // expect: security-xss

$page = basename($_GET['page']);
include __DIR__ . "/pages/$page.php";

$tri = $_GET['tri'];
if (!in_array($tri, ['nom', 'date'], true)) {
    exit;
}
query("SELECT * FROM clients ORDER BY $tri");
