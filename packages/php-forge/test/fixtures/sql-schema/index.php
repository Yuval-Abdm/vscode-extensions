<?php
$res = mysqli_query($db, "SELECT c.nom, c.email, k.montant FROM clients c JOIN contrats k ON k.client_id = c.id");
$res = mysqli_query($db, "SELECT c.prenom FROM clients c"); // expect: sql-unknown-column
$res = mysqli_query($db, "SELECT total, remise FROM factures");
$sql = "SELECT nom, FROM clients"; // expect: sql-syntax
$sql = 'SELECT nom FROM clients WHERE id = ' . $id . ' AND solde > 0';
$sql = "SELECT * FROM inconnue";
/** @sql */
$where = 'solde > 0 AND nom = ' . $nom;
$row = mysqli_fetch_assoc($res);
echo $row['nom'];
