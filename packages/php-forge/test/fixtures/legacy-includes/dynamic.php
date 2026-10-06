<?php
include $_SERVER['DOCUMENT_ROOT'] . '/rp_appInit.php';
$page = $_GET['p'];
include ROOT_PATH . '/templates/' . $page . '.php'; // expect: unresolved-include
echo $anything_after;
